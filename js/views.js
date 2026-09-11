/* UI 层：三个页面（拍照录入 / 错题本 / 统计设置）+ 错题详情弹层 */
window.Views = (function () {

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var _toastTimer = null;
  function toast(msg, ms) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { t.classList.remove('on'); }, ms || 2000);
  }

  /* ---------- 通用弹层 ---------- */
  function sheet(title, bodyHTML, onMount) {
    var root = document.getElementById('sheetRoot');
    root.innerHTML =
      '<div class="mask" data-mask="1"><div class="sheet">' +
      '<div class="sheet-hd"><h3>' + esc(title) + '</h3>' +
      '<button data-act="close-sheet" style="font-size:24px;line-height:1;color:var(--muted);padding:2px 6px">&times;</button></div>' +
      '<div class="sheet-bd">' + bodyHTML + '</div></div></div>';
    root.querySelector('[data-mask]').addEventListener('click', function (e) {
      if (e.target.dataset.mask) closeSheet();
    });
    root.querySelector('[data-act="close-sheet"]').addEventListener('click', closeSheet);
    if (onMount) onMount(root.querySelector('.sheet-bd'));
  }
  function closeSheet() {
    closeSolutionViewer();       // 详情页关了，浮在上面的大图也一起收掉
    clearSolutionPicker();       // 没走完的解答录入也一并作废，避免影响录入页
    document.getElementById('sheetRoot').innerHTML = '';
  }

  function confirmBox(title, text, onOk) {
    sheet(title,
      '<p style="font-size:14px;color:var(--muted);margin-bottom:16px">' + esc(text) + '</p>' +
      '<div class="row"><button class="btn line" style="flex:1" data-act="close-sheet">取消</button>' +
      '<button class="btn danger" style="flex:1" id="cfmOk">确定</button></div>',
      function (bd) {
        bd.querySelector('#cfmOk').addEventListener('click', function () { closeSheet(); onOk(); });
      });
  }

  /* ---------- 图片压缩：手机直出图动辄 5MB，压缩后上传更快、大模型费用也更低 ---------- */
  function compress(file, maxSide) {
    maxSide = maxSide || 1280;
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var img = new Image();
        img.onload = function () {
          var w = img.width, h = img.height;
          var scale = Math.min(1, maxSide / Math.max(w, h));
          var cv = document.createElement('canvas');
          cv.width = Math.round(w * scale);
          cv.height = Math.round(h * scale);
          var ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, cv.width, cv.height);
          ctx.drawImage(img, 0, 0, cv.width, cv.height);
          // 逐步降质，尽量控制在 1.5MB 内
          var q = 0.9, out = cv.toDataURL('image/jpeg', q);
          while (out.length > 1.5 * 1024 * 1024 && q > 0.5) {
            q -= 0.1;
            out = cv.toDataURL('image/jpeg', q);
          }
          resolve(out);
        };
        img.onerror = function () { reject(new Error('图片解析失败')); };
        img.src = fr.result;
      };
      fr.onerror = function () { reject(new Error('文件读取失败')); };
      fr.readAsDataURL(file);
    });
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function offlineBar() {
    return Store.isOnline() ? '' :
      '<div class="offline-bar">⚠️ 后端未连接，当前为离线模式（数据仅存本机浏览器）</div>';
  }

  /* =============== 页面一：拍照录入 =============== */
  /* 待保存的图片（dataURL）数组。拍一整张卷子时可以连着框好几道题，
   * 一起保存 —— 科目年级共用，备注共用。 */
  var pending = [];

  function canReuse() { return typeof Crop !== 'undefined' && Crop.hasSource(); }

  function previewHTML() {
    if (!pending.length) return '<div class="empty-ico">🖼️</div>';
    var multi = pending.length > 1;
    return '<div class="preview-strip' + (multi ? '' : ' single') + '">' +
      pending.map(function (d, i) {
        return '<div class="pv-item">' +
          '<img src="' + d + '" alt="错题">' +
          (multi ? '<span class="pv-idx">第 ' + (i + 1) + ' 题</span>' : '') +
          '<button type="button" class="pv-del" data-del="' + i + '" title="移除">&times;</button>' +
          '</div>';
      }).join('') + '</div>';
  }

  function renderCapture(pane) {
    var st = Store.getSettings();
    var s = st.defaultSubject || 'math';
    var g = st.defaultGrade || '7';

    var subjSeg = Store.SUBJECTS.map(function (x) {
      return '<button type="button" data-subj="' + x.id + '" class="' + (x.id === s ? 'on' : '') + '">' +
        x.icon + ' ' + x.name + '</button>';
    }).join('');
    var gradeSeg = Store.GRADES.map(function (x) {
      return '<button type="button" data-grade="' + x.id + '" class="' + (x.id === String(g) ? 'on' : '') + '">' +
        x.name + '</button>';
    }).join('');

    pane.innerHTML =
      offlineBar() +
      '<div class="card">' +
        '<div class="card-t">📷 错题照片<span id="pvCount" class="pv-count"></span></div>' +
        '<div id="previewBox" class="preview">' + previewHTML() + '</div>' +
        '<div class="row" style="margin-top:10px">' +
          '<button class="btn soft" style="flex:1" id="btnPick">📷 拍照</button>' +
          '<button class="btn soft" style="flex:1" id="btnAlbum">🖼 相册</button>' +
          '<button class="btn line" style="flex:0 0 auto" id="btnClear">清除</button>' +
        '</div>' +
        '<div id="moreRow" style="margin-top:8px"></div>' +
        '<div class="hint">拍下整张卷子 → 拖动取景框只框住要录入的那一道题：字迹更清楚，AI 也不容易被同页其它题带偏</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-t">📚 归类</div>' +
        '<div class="field"><label>科目</label><div class="seg" id="segSubject">' + subjSeg + '</div></div>' +
        '<div class="field" style="margin-bottom:0"><label>年级</label><div class="seg" id="segGrade">' + gradeSeg + '</div></div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="field" style="margin-bottom:0">' +
          '<label>备注（可选，建议写第几题 + 你当时的答案，AI 分析时会一起看）</label>' +
          '<textarea class="input" id="noteInput" placeholder="例如：第3题，我答的是 36；或：月考第 12 题，计算符号写错"></textarea>' +
        '</div>' +
      '</div>' +

      '<button class="btn full" id="btnSave" style="margin-bottom:12px">保存到错题本</button>';

    // 预览容器
    var box = pane.querySelector('#previewBox');

    /* 预览区与按钮状态同步（增删图片后调用，不重建整页） */
    function syncCapture() {
      box.innerHTML = previewHTML();
      var cnt = pane.querySelector('#pvCount');
      if (cnt) cnt.textContent = pending.length ? '（' + pending.length + ' 张）' : '';

      var more = pane.querySelector('#moreRow');
      if (more) {
        more.innerHTML = canReuse()
          ? '<button class="btn line full" id="btnAgain" style="font-size:13px">＋ 继续框这张卷子上的下一道题</button>'
          : '';
        var again = more.querySelector('#btnAgain');
        if (again) {
          again.addEventListener('click', function () {
            Crop.reopen({ onRetake: function () { pickFile('fileInput'); } }).then(function (out) {
              if (!out) return;
              pending.push(out);
              syncCapture();
              toast('已加入第 ' + pending.length + ' 张');
            });
          });
        }
      }

      var save = pane.querySelector('#btnSave');
      if (save) save.textContent = pending.length > 1 ? ('保存 ' + pending.length + ' 道错题') : '保存到错题本';
    }

    function pickFile(which) {
      document.getElementById(which || 'fileInput').click();
    }

    // 移除预览里的某一张
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-del]');
      if (!b) return;
      pending.splice(Number(b.dataset.del), 1);
      syncCapture();
    });

    pane.querySelector('#btnPick').addEventListener('click', function () { pickFile('fileInput'); });
    pane.querySelector('#btnAlbum').addEventListener('click', function () { pickFile('fileInputAlbum'); });
    pane.querySelector('#btnClear').addEventListener('click', function () {
      pending = [];
      Crop.clearSource();
      syncCapture();
    });

    pane.querySelector('#segSubject').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-subj]');
      if (!b) return;
      Array.prototype.forEach.call(this.children, function (c) { c.classList.remove('on'); });
      b.classList.add('on');
    });
    pane.querySelector('#segGrade').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-grade]');
      if (!b) return;
      Array.prototype.forEach.call(this.children, function (c) { c.classList.remove('on'); });
      b.classList.add('on');
    });

    pane.querySelector('#btnSave').addEventListener('click', function () {
      if (!pending.length) return toast('请先拍照并框选题目');
      var sb = pane.querySelector('#segSubject button.on');
      var gb = pane.querySelector('#segGrade button.on');
      var subject = sb ? sb.dataset.subj : 'math';
      var grade = gb ? gb.dataset.grade : '7';
      var note = pane.querySelector('#noteInput').value.trim();
      var imgs = pending.slice();          // 快照，保存过程中即使列表变化也不影响
      var btn = this;
      btn.disabled = true;
      btn.textContent = '保存中…';

      // 逐张提交（并发会让服务端同时写多个文件，串行更稳）
      var okCount = 0, failCount = 0, chain = Promise.resolve();
      imgs.forEach(function (dataUrl) {
        chain = chain.then(function () {
          return Store.add({ subject: subject, grade: grade, image: dataUrl, note: note })
            .then(function (j) { if (j && j.ok) okCount++; else failCount++; })
            .catch(function () { failCount++; });
        });
      });

      chain.then(function () {
        if (okCount) {
          // 记住本次选择，下次默认同科目同年级
          Store.saveSettings({ defaultSubject: subject, defaultGrade: grade });
          pending = [];
          Crop.clearSource();
          renderCapture(pane);             // 重置表单
          App.refreshBook();               // 刷新错题本
          App.refreshStats();
        }
        toast(failCount
          ? ('成功 ' + okCount + ' 张，失败 ' + failCount + ' 张')
          : (okCount > 1 ? (okCount + ' 道错题已加入错题本') : '已加入错题本'));
      }).finally(function () {
        btn.disabled = false;
        btn.textContent = '保存到错题本';
      });
    });

    // 供 App 在框选完成后追加图片
    pane._sync = syncCapture;
    pane._addImage = function (dataUrl) {
      pending.push(dataUrl);
      syncCapture();
    };
    pane._setImage = function (dataUrl) {   // 兼容：直接替换为单张
      pending = [dataUrl];
      syncCapture();
    };
    syncCapture();
    return pane;
  }

  /* 追加一张已框选好的图片（由 App 在 Crop 完成后调用） */
  function captureAddImage(dataUrl) {
    var pane = document.getElementById('pane-capture');
    if (pane && pane._addImage) pane._addImage(dataUrl);
  }

  function captureSetImage(dataUrl) {
    var pane = document.getElementById('pane-capture');
    if (pane && pane._setImage) pane._setImage(dataUrl);
  }

  /* 切换账号/登出时清空待保存队列，避免上一个账号的图片留在页面上 */
  function captureReset() {
    pending = [];
    if (typeof Crop !== 'undefined') {
      Crop.close();
      Crop.clearSource();
    }
    var pane = document.getElementById('pane-capture');
    if (pane && pane._sync) pane._sync();
  }

  /* =============== 页面二：错题本 =============== */
  var filter = { subject: 'all', grade: 'all', mastered: 'all' };

  function renderBook(pane) {
    var allBtn = function (active) { return '<button type="button" data-subj="all" class="' + (active ? 'on' : '') + '">全部</button>'; };
    var subjSeg = allBtn(filter.subject === 'all') + Store.SUBJECTS.map(function (x) {
      return '<button type="button" data-subj="' + x.id + '" class="' + (filter.subject === x.id ? 'on' : '') + '">' +
        x.icon + ' ' + x.name + '</button>';
    }).join('');
    var gradeSeg = '<button type="button" data-grade="all" class="' + (filter.grade === 'all' ? 'on' : '') + '">全部</button>' +
      Store.GRADES.map(function (x) {
        return '<button type="button" data-grade="' + x.id + '" class="' + (filter.grade === x.id ? 'on' : '') + '">' + x.name + '</button>';
      }).join('');
    // 掌握情况：全部 / 还需要复习(false) / 已会(true)
    var mSeg = [['all', '全部'], ['0', '📌 还需要复习'], ['1', '✅ 已会']].map(function (p) {
      return '<button type="button" data-mastered="' + p[0] + '" class="' + (filter.mastered === p[0] ? 'on' : '') + '">' + p[1] + '</button>';
    }).join('');

    var list = Store.list({
      subject: filter.subject === 'all' ? '' : filter.subject,
      grade: filter.grade === 'all' ? '' : filter.grade,
      mastered: filter.mastered === 'all' ? '' : filter.mastered
    });

    var gridHTML;
    if (!list.length) {
      gridHTML = '<div class="empty"><div class="ico">📝</div><div class="t">' +
        (filter.mastered === '1' ? '这组里还没有已会的错题'
          : filter.mastered === '0' ? '这组里没有待复习的错题，都掌握了 👍'
            : '还没有错题') + '</div>' +
        '<div class="s">' + (filter.mastered === 'all' ? '去「录入」页拍下第一道错题吧' : '换个筛选条件看看') + '</div></div>';
    } else {
      gridHTML = '<div class="grid">' + list.map(function (it) {
        var meta = Store.subjectMeta(it.subject);
        var done = it.analysis ? '<span class="badge done">已分析</span>' : '';
        // 已会：右上角打勾标记 + 缩略图淡一点，一眼能和「还要复习」的区分开
        var mBadge = it.mastered ? '<span class="badge mastered">✓ 已会</span>' : '';
        // 有他人正确解答的题，在缩略图左上角标一下（详情页里能看/能加）
        var sol = it.solutionCount ? '<span class="badge sol">👥 ' + it.solutionCount + '</span>' : '';
        return '<div class="grid-item' + (it.mastered ? ' is-mastered' : '') + '" data-id="' + it.id + '">' +
          '<img class="thumb" src="' + esc(it.image) + '" alt="错题" loading="lazy">' + sol +
          '<div class="badges">' + done + mBadge + '</div>' +
          '<div class="meta">' +
            '<div class="sbj" style="color:' + meta.color + '">' + meta.icon + ' ' + esc(meta.name) + ' · ' + esc(Store.gradeName(it.grade)) + '</div>' +
            '<div class="dt">' + fmtDate(it.createdAt) + (it.mastered ? ' · ✓ 已会' : '') + '</div>' +
          '</div></div>';
      }).join('') + '</div>';
    }

    // 顶部小结：当前筛选下各状态有几道，点一下就知道「还剩几道要复习」
    var allOfScope = Store.list({
      subject: filter.subject === 'all' ? '' : filter.subject,
      grade: filter.grade === 'all' ? '' : filter.grade
    });
    var left = allOfScope.filter(function (x) { return !x.mastered; }).length;
    var doneN = allOfScope.length - left;

    pane.innerHTML =
      offlineBar() +
      '<div class="card">' +
        '<div class="field"><label>科目</label><div class="seg" id="fSubject">' + subjSeg + '</div></div>' +
        '<div class="field"><label>年级</label><div class="seg" id="fGrade">' + gradeSeg + '</div></div>' +
        '<div class="field" style="margin-bottom:0"><label>掌握情况</label><div class="seg" id="fMastered">' + mSeg + '</div></div>' +
      '</div>' +
      '<div style="font-size:13px;color:var(--muted);margin:0 4px 10px">' +
        (filter.mastered === 'all'
          ? '共 ' + allOfScope.length + ' 道错题 · 还需要复习 ' + left + ' 道 · 已会 ' + doneN + ' 道'
          : '当前筛选 ' + list.length + ' 道') +
      '</div>' +
      gridHTML;

    pane.querySelector('#fSubject').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-subj]');
      if (!b) return;
      filter.subject = b.dataset.subj;
      renderBook(pane);
    });
    pane.querySelector('#fGrade').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-grade]');
      if (!b) return;
      filter.grade = b.dataset.grade;
      renderBook(pane);
    });
    pane.querySelector('#fMastered').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-mastered]');
      if (!b) return;
      filter.mastered = b.dataset.mastered;
      renderBook(pane);
    });

    Array.prototype.forEach.call(pane.querySelectorAll('.grid-item'), function (el) {
      el.addEventListener('click', function () { openDetail(el.dataset.id); });
    });
  }

  /* =============== 他人正确解答 ===============
   * 拍同学/老师写的正确解法，挂在错题下面（单独存 solutions 表，一条错题对应多张）。
   * 拍照与录入页共用同一套框选编辑器（Crop），但走独立的文件输入：
   * 详情页先注册接收器，App 框完把图片交回来，图片不会混进「待录入」队列。
   */
  var solPickerCb = null;      // 详情页注册的图片接收器

  function registerSolutionPicker(cb) { solPickerCb = cb; }
  function clearSolutionPicker() { solPickerCb = null; }
  /* 由 App 在框选完成后调用 */
  function solutionImagePicked(dataUrl) { if (solPickerCb) solPickerCb(dataUrl); }

  function pickSolutionImage(which) {
    var inp = document.getElementById(which === 'album' ? 'fileInputSolAlbum' : 'fileInputSol');
    if (inp) inp.click();
  }

  /* 小×按钮的「点两次才删」：避免手滑删掉，也不需要再弹一层确认（弹层会盖掉详情页） */
  function armDelete(btn, onYes) {
    if (btn.dataset.armed) { btn.dataset.armed = ''; btn.classList.remove('armed'); onYes(); return; }
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    btn.textContent = '再点一次会删除';
    setTimeout(function () {
      if (!btn.dataset.armed) return;
      btn.dataset.armed = ''; btn.classList.remove('armed'); btn.textContent = '×';
    }, 3000);
  }

  function solutionsHTML(it) {
    var list = it.solutions || [];
    var strip = list.length
      ? '<div class="sol-strip">' + list.map(function (s, i) {
        return '<div class="sol-item">' +
          '<img src="' + esc(s.image) + '" alt="他人正确解答" data-view="' + esc(s.id) + '" loading="lazy">' +
          '<span class="sol-badge">' + (i + 1) + '</span>' +
          '<button type="button" class="pv-del" data-delsol="' + esc(s.id) + '" title="删除">&times;</button>' +
          (s.note ? '<span class="sol-note">' + esc(s.note) + '</span>' : '') +
          '</div>';
      }).join('') + '</div>'
      : '<div class="sol-empty">还没有他人解答。拍下同学或老师写的正确解法，和自己的作答对照看差在哪一步。</div>';
    return strip +
      '<div class="row" style="margin-top:8px">' +
        '<button class="btn soft" style="flex:1" id="solPick" type="button">📷 拍照</button>' +
        '<button class="btn soft" style="flex:1" id="solAlbum" type="button">🖼 相册</button>' +
      '</div>';
  }

  /* 大图查看：可补一句说明（谁写的 / 哪一步不一样），也可删除 */
  var solViewerEl = null;
  function closeSolutionViewer() {
    if (solViewerEl && solViewerEl.parentNode) solViewerEl.parentNode.removeChild(solViewerEl);
    solViewerEl = null;
  }
  function openSolutionViewer(sol, onChange) {
    closeSolutionViewer();
    var d = document.createElement('div');
    d.className = 'sol-viewer';
    d.innerHTML =
      '<div class="sol-viewer-hd"><span>他人正确解答</span>' +
      '<button type="button" class="sol-x" data-act="close">&times;</button></div>' +
      '<div class="sol-viewer-bd"><img src="' + esc(sol.image) + '" alt="他人正确解答"></div>' +
      '<div class="sol-viewer-ft">' +
        '<input class="input" id="solNoteEdit" value="' + esc(sol.note || '') + '" ' +
          'placeholder="加个说明，例如：张老师课上的解法 / 第 2 步不一样">' +
        '<button class="btn danger" type="button" id="solViewerDel" style="flex:0 0 auto">删除</button>' +
      '</div>';
    document.body.appendChild(d);
    solViewerEl = d;

    d.querySelector('[data-act="close"]').addEventListener('click', closeSolutionViewer);
    d.addEventListener('click', function (e) { if (e.target === d) closeSolutionViewer(); });

    // 说明失焦时保存一次，不按键就发请求
    var input = d.querySelector('#solNoteEdit');
    input.addEventListener('change', function () {
      var v = input.value.trim();
      if (v === (sol.note || '')) return;
      Store.updateSolution(sol.id, { note: v }).then(function (j) {
        if (j && j.ok) { sol.note = v; toast('说明已保存'); if (onChange) onChange(); }
        else toast('保存失败：' + ((j && j.error) || '未知错误'), 3000);
      });
    });

    // 删除也走「点两次」，理由同上：不再叠一层 confirm 盖掉详情页
    var del = d.querySelector('#solViewerDel');
    del.addEventListener('click', function () {
      if (!del.dataset.armed) {
        del.dataset.armed = '1';
        del.textContent = '再点一次会删除';
        setTimeout(function () { if (del.dataset.armed) { del.dataset.armed = ''; del.textContent = '删除'; } }, 3000);
        return;
      }
      del.dataset.armed = '';
      Store.removeSolution(sol.id).then(function () {
        closeSolutionViewer();
        toast('已删除');
        if (onChange) onChange();
        App.refreshBook();
      });
    });
  }

  /* =============== 错题详情 =============== */
  function openDetail(id) {
    var it = Store.get(id);
    if (!it) return toast('错题不存在');
    var meta = Store.subjectMeta(it.subject);

    var analysisHTML;
    if (it.analysis) {
      var a = it.analysis;
      var sim = a.similar || null;
      /* 质量提示：以前模型跑飞（输出被截断 / 全程自我推翻）时界面照样显示"分析完成"，
       * 用户看到的是一堆自问自答的步骤。现在把问题显式说出来。 */
      var qwarn = '';
      if (a._unparsed || a.quality === 'low') {
        qwarn = '<div class="k-box" style="margin-bottom:10px;color:var(--warn)">⚠️ 这次分析没成功（' +
          esc((a.warnings && a.warnings[0]) || '模型输出异常') + '）。建议点「重新分析」；若连续失败，请重新拍照：' +
          '画面只留这一道题、对准题目、避免反光和斜拍。</div>';
      } else if (a.quality === 'partial') {
        qwarn = '<div class="k-box" style="margin-bottom:10px;color:var(--warn)">⚠️ ' +
          esc((a.warnings || []).join('；')) + '。结果仅供参考，必要时请点「重新分析」。</div>';
      }
      analysisHTML =
        qwarn +
        (a.uncertain ? '<div class="k-box" style="margin-bottom:10px;color:var(--warn)">⚠️ 模型对识题有不确定之处，结论仅供参考</div>' : '') +
        (a.question ? '<div class="sec-t">📖 题目</div><div style="font-size:14px;line-height:1.6">' + esc(a.question) + '</div>' +
          (a.noteUsed ? '<div style="font-size:12px;color:var(--muted);margin-top:6px">本次分析参考的备注：' + esc(a.noteUsed) + '</div>' : '') : '') +
        (a.studentAnswer ? '<div class="sec-t">✍️ 学生原答案</div><div class="ans-box--mine">' + esc(a.studentAnswer) + '</div>' : '') +
        (a.answer ? '<div class="sec-t">✅ 答案</div><div class="ans-box"><div class="t">正确答案</div><div class="v">' + esc(a.answer) + '</div></div>' : '') +
        (a.why ? '<div class="sec-t">💡 为什么这样做</div><div class="why-box">' + esc(a.why) + '</div>' : '') +
        (a.steps && a.steps.length ? '<div class="sec-t">📝 分步讲解</div><ol class="steps">' +
          a.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' : '') +
        (a.knowledge ? '<div class="sec-t">🎯 知识点</div><div class="k-box">' + esc(a.knowledge) + '</div>' : '') +
        ((a.causeType || a.causeDetail) ? '<div class="sec-t">🔍 错因分析</div>' +
          (a.causeType ? '<div style="margin-bottom:6px"><span class="pill">' + esc(a.causeType) + '</span></div>' : '') +
          (a.causeDetail ? '<div class="k-box">' + esc(a.causeDetail) + '</div>' : '') : '') +
        (a.fixOneLine ? '<div class="sec-t">✏️ 一句话订正</div><div class="tip-box">' + esc(a.fixOneLine) + '</div>' : '') +
        (a.tip ? '<div class="sec-t">⚠️ 易错点</div><div class="tip-box">' + esc(a.tip) + '</div>' : '') +
        (sim && sim.q ? '<div class="sec-t">🔁 同类变式题</div>' +
          '<div class="k-box">' + esc(sim.q) +
            (sim.hint ? '<div style="font-size:12px;color:var(--muted);margin-top:8px">提示：' + esc(sim.hint) + '</div>' : '') +
            (sim.a ? '<div style="font-size:12px;color:var(--muted);margin-top:4px">参考答案：' + esc(sim.a) + '</div>' : '') +
          '</div>' : '') +
        ((a.reviewDays || a.reviewFocus) ? '<div class="sec-t">📅 复习安排</div><div class="tip-box">' +
          (a.reviewDays ? '<b>' + a.reviewDays + ' 天后重做这道题</b>' : '') +
          (a.reviewFocus ? (a.reviewDays ? '<br>' : '') + esc(a.reviewFocus) : '') + '</div>' : '');
    } else {
      analysisHTML = '<div style="text-align:center;padding:18px;color:var(--muted);font-size:14px">' +
        '还没有分析过，点击下方按钮让 AI 讲解这道题</div>';
    }

    var body =
      '<img class="detail-img" src="' + esc(it.image) + '" alt="错题" style="margin-bottom:12px">' +
      '<div style="font-size:12px;color:var(--muted);margin-bottom:12px">' +
        meta.icon + ' ' + esc(meta.name) + ' · ' + esc(Store.gradeName(it.grade)) + ' · ' + fmtDate(it.createdAt) +
      '</div>' +
      '<div class="field" style="margin-bottom:12px">' +
        '<label>📌 备注（会连同图片一起发给 AI：写第几题能锁定题目，写你的答案能判断错因）</label>' +
        '<input class="input" id="noteInput" value="' + esc(it.note || '') + '" placeholder="例如：第3题，我答的是 36">' +
      '</div>' +
      '<div class="field" style="margin-bottom:12px">' +
        '<label>👥 他人正确解答（拍同学或老师写的正确解法，可多张）</label>' +
        '<div id="solBox">' + solutionsHTML(it) + '</div>' +
      '</div>' +
      '<div id="analysisBox">' + analysisHTML + '</div>' +
      '<div class="row" style="margin-top:16px">' +
        '<button class="btn" style="flex:1" id="btnAnalyze">' + (it.analysis ? '重新分析' : 'AI 分析') + '</button>' +
        '<button class="btn danger" style="flex:0 0 auto" id="btnDel">删除</button>' +
      '</div>' +
      /* 是否已会：单独一行放在删除按钮下面（错题本可按「已会 / 还需要复习」筛选） */
      '<button class="btn full ' + (it.mastered ? 'ok' : 'line') + '" id="btnMastered" style="margin-top:10px">' +
        (it.mastered ? '✅ 已会（点一下取消）' : '标记为已会') +
      '</button>' +
      '<div class="hint" style="text-align:center;margin-top:6px">标为「已会」后就不再出现在错题本的「还需要复习」里，随时能取消</div>' +
      '<div class="hint" style="text-align:center;margin-top:8px">分析时会把上面的备注一起发给大模型（备注里的题号能帮它在一图多题时锁定目标），需要模型支持图片识别</div>';

    sheet('错题详情', body, function (bd) {
      /* ---- 他人正确解答：渲染 / 增 / 删 / 看大图 ---- */
      var solBox = bd.querySelector('#solBox');
      var solTouched = false;         // 本次打开里用户已经动过解答（避免迟到的列表覆盖新加的那张）
      var lastWhich = 'camera';       // 刚点的是拍照还是相册（只影响提示文案）

      function refreshSolBox() { solBox.innerHTML = solutionsHTML(it); }

      function removeSol(sid) {
        Store.removeSolution(sid).then(function (j) {
          if (j && j.ok === false) toast('删除失败：' + (j.error || '未知错误'), 3000);
          else { toast('已删除'); App.refreshBook(); }
          refreshSolBox();
        });
      }

      function uploadSol(dataUrl, which) {
        var btns = solBox.querySelectorAll('button');
        Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
        toast('上传中…', 4000);
        Store.addSolution(it.id, { image: dataUrl })
          .then(function (j) {
            if (j && j.ok) { toast(which === 'album' ? '已从相册添加' : '已添加他人解答'); App.refreshBook(); }
            else toast('添加失败：' + ((j && j.error) || '未知错误'), 3500);
            refreshSolBox();
          })
          .catch(function (e) { toast('添加失败：' + e.message, 3500); refreshSolBox(); });
      }

      solBox.addEventListener('click', function (e) {
        var del = e.target.closest('[data-delsol]');
        if (del) { armDelete(del, function () { removeSol(del.dataset.delsol); }); return; }

        var view = e.target.closest('[data-view]');
        if (view) {
          var sid = view.dataset.view;
          var sol = (it.solutions || []).filter(function (s) { return s.id === sid; })[0];
          if (sol) openSolutionViewer(sol, refreshSolBox);
          return;
        }
        if (e.target.closest('#solPick')) { lastWhich = 'camera'; pickSolutionImage('camera'); return; }
        if (e.target.closest('#solAlbum')) { lastWhich = 'album'; pickSolutionImage('album'); }
      });

      // 注册接收器：App 在框选编辑器里确认后，把图片交到这里来
      registerSolutionPicker(function (dataUrl) {
        if (!dataUrl) { refreshSolBox(); return; }      // 取消 / 半途退出
        solTouched = true;
        uploadSol(dataUrl, lastWhich);
      });

      // 懒加载：列表接口只带张数，解答明细进详情页才拉
      if (!it._local) {
        Store.loadSolutions(it.id).then(function () {
          if (!solTouched) refreshSolBox();
        });
      }

      bd.querySelector('#btnAnalyze').addEventListener('click', function () {
        var btn = this;
        btn.disabled = true;
        btn.textContent = '分析中…';
        bd.querySelector('#analysisBox').innerHTML =
          '<div class="loading"><div class="spin"></div>AI 正在看图分析，请稍候（约 ' +
          ((Store.getSettings() || {}).deepThinking ? '60-180' : '15-45') +
          ' 秒，图形复杂的题会更久；万一模型跑飞会自动重试一次）</div>';

        // 先取输入框里最新的备注（可能刚补了「第几题」），有改动就先存下来，再连同图片一起分析
        var noteEl = bd.querySelector('#noteInput');
        var note = noteEl ? noteEl.value.trim() : (it.note || '');
        var saveNote = (note !== (it.note || ''))
          ? Store.update(it.id, { note: note }) : Promise.resolve({ ok: true });

        saveNote.then(function () {
          it.note = note;
          App.refreshBook();
          return AI.analyze(it.image, it.subject, it.grade, note);
        })
          .then(function (result) {
            Store.update(it.id, { analysis: result }).then(function () {
              toast('分析完成');
              closeSheet();
              openDetail(it.id);       // 重新打开以展示结果
              App.refreshBook();
              App.refreshStats();
            });
          })
          .catch(function (e) {
            toast('分析失败：' + e.message);
            closeSheet();
            openDetail(it.id);
          })
          .finally(function () { btn.disabled = false; });
      });

      bd.querySelector('#btnDel').addEventListener('click', function () {
        confirmBox('删除错题', '确定删除这道错题吗？图片和分析结果会一并删除。', function () {
          Store.remove(it.id).then(function () {
            toast('已删除');
            closeSheet();
            App.refreshBook();
            App.refreshStats();
          });
        });
      });

      /* 是否已会：本地先翻状态（按钮立刻变），再存服务端；失败就翻回来 */
      var mBtn = bd.querySelector('#btnMastered');
      function paintMastered() {
        mBtn.className = 'btn full ' + (it.mastered ? 'ok' : 'line');
        mBtn.textContent = it.mastered ? '✅ 已会（点一下取消）' : '标记为已会';
        mBtn.disabled = false;
      }
      mBtn.addEventListener('click', function () {
        var next = !it.mastered;
        mBtn.disabled = true;
        Store.setMastered(it.id, next).then(function (j) {
          if (j && j.ok === false) {
            it.mastered = !next;
            toast('标记失败：' + (j.error || '未知错误'), 3000);
          } else {
            it.mastered = next;
            toast(next ? '已标记为「已会」' : '已改回「还需要复习」');
          }
          paintMastered();
          App.refreshBook();
        }).catch(function (e) {
          it.mastered = !next;
          toast('标记失败：' + e.message, 3000);
          paintMastered();
        });
      });
    });
  }

  /* =============== 大模型服务商 ===============
   * 与 enStudy 保持一致的服务商清单：切换服务商时，各自保存自己的 Key 与模型，互不影响。
   * b = API Base，m = 该服务商默认模型（都必须是支持图片输入的多模态模型）。
   * 新增服务商需同时在 server.js 的 ALLOWED_HOST_SUFFIXES 加白名单，否则服务端会拒绝转发。
   */
  var PROVIDERS = {
    siliconflow: { n: '硅基流动 SiliconFlow', b: 'https://api.siliconflow.cn/v1', m: 'Qwen/Qwen2.5-VL-32B-Instruct' },
    openai: { n: 'OpenAI', b: 'https://api.openai.com/v1', m: 'gpt-4o' },
    bailian: { n: '阿里百炼（通义千问）', b: 'https://dashscope.aliyuncs.com/compatible-mode/v1', m: 'qwen-vl-max-latest' },
    zhipu: { n: '智谱 GLM', b: 'https://open.bigmodel.cn/api/paas/v4', m: 'glm-4v-flash' },
    bailian_tokenplan: { n: '阿里百炼 Token Plan', b: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', m: 'qwen3.7-plus' },
    amd: { n: 'AMD Radeon Cloud', b: 'https://developer.amd.com.cn/radeon/api/v1', m: 'Qwen3.8-Flash-Next' },
    litellm: { n: 'LiteLLM（自建代理）', b: 'http://120.25.204.182:14000/v1', m: '' },
    custom: { n: '自定义', b: '', m: '' }
  };
  // 阿里百炼视觉模型档位（不同模型额度与单价不同）
  var BAILIAN_PLANS = [
    { v: 'qwen-vl-max-latest', t: '通义千问 VL-Max（旗舰，效果最佳）' },
    { v: 'qwen-vl-plus-latest', t: '通义千问 VL-Plus（均衡性价比）' },
    { v: 'qwen2.5-vl-72b-instruct', t: 'Qwen2.5-VL-72B（开源旗舰）' },
    { v: 'qwen2.5-vl-32b-instruct', t: 'Qwen2.5-VL-32B' },
    { v: 'qwen2.5-vl-7b-instruct', t: 'Qwen2.5-VL-7B（轻量/低耗）' }
  ];
  // 阿里百炼 Token Plan 套餐：预付费 Credits，专属端点 + sk-sp- 开头 Key。
  // 下面「视觉 / 纯文本」的标注是 2026-09-10 逐个模型实测得出的（发同一张错题图问题号）：
  //   qwen3.8-max / 3.8-flash / 3.7-plus / 3.6-flash 能正确读出「12、13、14」；
  //   qwen3.7-max 直接报 invalid_parameter_error；glm-5.2 答「无」；deepseek-v4-pro 编造「36、37…」。
  var TOKENPLAN_PLANS = [
    { v: 'qwen3.8-max', t: 'Qwen3.8-Max（✅ 能看图，最强推理）' },
    { v: 'qwen3.7-plus', t: 'Qwen3.7-Plus（✅ 能看图，推荐）' },
    { v: 'qwen3.8-flash', t: 'Qwen3.8-Flash（✅ 能看图，快）' },
    { v: 'qwen3.6-flash', t: 'Qwen3.6-Flash（✅ 能看图，快）' },
    { v: 'qwen3.7-max', t: 'Qwen3.7-Max（❌ 纯文本，不能看图）' },
    { v: 'glm-5.2', t: 'GLM-5.2（❌ 纯文本，不能看图）' },
    { v: 'deepseek-v4-pro', t: 'DeepSeek-V4-Pro（❌ 纯文本，不能看图）' }
  ];
  function planListFor(prov) {
    if (prov === 'bailian') return BAILIAN_PLANS;
    if (prov === 'bailian_tokenplan') return TOKENPLAN_PLANS;
    return null;
  }
  function providerOf(base) {
    var ks = Object.keys(PROVIDERS);
    for (var i = 0; i < ks.length; i++) {
      if (PROVIDERS[ks[i]].b && base === PROVIDERS[ks[i]].b) return ks[i];
    }
    return 'custom';
  }
  // 旧数据迁移：把历史「全局唯一」的 apiKey/model 归入当前服务商名下
  function ensureProvidersMigrated(s) {
    if (s.currentProvider) return;
    var prov = providerOf(s.apiBase);
    s.providers = s.providers || {};
    if (!s.providers[prov]) s.providers[prov] = { apiKey: s.apiKey || '', model: s.model || '' };
    s.currentProvider = prov;
    Store.saveSettings({ providers: s.providers, currentProvider: prov });
  }

  /* =============== 页面三：统计与设置 =============== */
  function renderStats(pane) {
    var all = Store.all();
    var math = all.filter(function (x) { return x.subject === 'math'; }).length;
    var phy = all.filter(function (x) { return x.subject === 'physics'; }).length;
    var analyzed = all.filter(function (x) { return x.analysis; }).length;

    var bySubjectGrade = Store.SUBJECTS.map(function (s) {
      var row = Store.GRADES.map(function (g) {
        var n = all.filter(function (x) {
          return x.subject === s.id && String(x.grade) === g.id;
        }).length;
        return '<div style="flex:1;text-align:center"><div style="font-size:18px;font-weight:700;color:' +
          (n ? s.color : 'var(--muted)') + '">' + n + '</div><div style="font-size:11px;color:var(--muted)">' + g.name + '</div></div>';
      }).join('');
      return '<div style="margin-bottom:10px"><div style="font-size:13px;font-weight:600;margin-bottom:4px">' +
        s.icon + ' ' + s.name + '</div><div style="display:flex">' + row + '</div></div>';
    }).join('');

    var st = Store.getSettings();
    ensureProvidersMigrated(st);
    var curProv = st.currentProvider || providerOf(st.apiBase);
    var provOptions = Object.keys(PROVIDERS).map(function (k) {
      return '<option value="' + esc(k) + '"' + (k === curProv ? ' selected' : '') + '>' + esc(PROVIDERS[k].n) + '</option>';
    }).join('');

    pane.innerHTML =
      offlineBar() +
      '<div class="stat-row">' +
        '<div class="stat"><div class="n">' + all.length + '</div><div class="l">总错题</div></div>' +
        '<div class="stat"><div class="n" style="color:var(--ok)">' + analyzed + '</div><div class="l">已分析</div></div>' +
        '<div class="stat"><div class="n" style="color:var(--warn)">' + (all.length - analyzed) + '</div><div class="l">待分析</div></div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-t">📊 分布</div>' +
        '<div class="stat-row" style="margin-bottom:14px">' +
          '<div class="stat"><div class="n" style="color:#4f46e5">' + math + '</div><div class="l">数学</div></div>' +
          '<div class="stat"><div class="n" style="color:#0891b2">' + phy + '</div><div class="l">物理</div></div>' +
        '</div>' +
        bySubjectGrade +
      '</div>' +

      '<div class="card">' +
        '<div class="card-t">🤖 大模型设置</div>' +
        '<div class="field"><label>服务商</label>' +
          '<select class="input" id="cfgProvider">' + provOptions + '</select>' +
          '<div class="hint">切换服务商会自动带出它自己的 Key 与模型，各家互不干扰</div>' +
        '</div>' +
        '<div class="field"><label>API Base（OpenAI 兼容）</label>' +
          '<input class="input" id="cfgBase" value="' + esc(st.apiBase) + '" placeholder="https://api.siliconflow.cn/v1"></div>' +
        '<div class="field" id="cfgPlanField" style="display:' + (planListFor(curProv) ? '' : 'none') + '">' +
          '<label>百炼 模型 / Token 计划</label>' +
          '<select class="input" id="cfgPlan">' +
            (planListFor(curProv) || BAILIAN_PLANS).map(function (p) {
              return '<option value="' + esc(p.v) + '"' + (p.v === st.model ? ' selected' : '') + '>' + esc(p.t) + '</option>';
            }).join('') +
          '</select>' +
          '<div class="hint" id="cfgPlanHint"></div>' +
        '</div>' +
        '<div class="field"><label>API Key</label>' +
          '<input class="input" id="cfgKey" type="password" value="' + esc(st.apiKey) + '" placeholder="' +
            (curProv === 'bailian_tokenplan' ? 'sk-sp-...' : 'sk-...') + '"></div>' +
        '<div class="field"><label>模型（需支持图片识别）</label>' +
          '<input class="input" id="cfgModel" value="' + esc(st.model) + '" placeholder="Qwen/Qwen2.5-VL-32B-Instruct">' +
          '<div class="hint" id="cfgVisionHint"></div></div>' +
        '<div class="field"><label>深度思考</label>' +
          '<label style="display:flex;align-items:center;gap:8px;font-size:14px">' +
            '<input type="checkbox" id="cfgThink"' + (st.deepThinking ? ' checked' : '') + ' style="width:18px;height:18px">' +
            '<span>模型先推演再作答（更严谨，但每题要等 30-90 秒）</span>' +
          '</label>' +
          '<div class="hint">默认关闭：实测关闭后 1-2 秒返回，且照样看得懂图；' +
          '只有遇到需要复杂推演的题再打开</div>' +
        '</div>' +
        '<div class="row">' +
          '<button class="btn line" style="flex:1" id="btnTest">测试连接</button>' +
          '<button class="btn" style="flex:1" id="btnSaveCfg">保存设置</button>' +
        '</div>' +
        '<div class="hint" style="margin-top:10px">' +
          '错题分析必须用<b>支持图片输入</b>的多模态模型：<br>' +
          '· 阿里百炼 Token Plan：Qwen3.8-Max / 3.7-Plus / 3.8-Flash / 3.6-Flash<br>' +
          '· 硅基流动 Qwen/Qwen2.5-VL-32B-Instruct（有免费额度）<br>' +
          '· 阿里百炼主站 qwen-vl-max-latest · 智谱 glm-4v-flash · OpenAI gpt-4o' +
        '</div>' +
      '</div>';

    var curProvId = curProv;
    var planField = pane.querySelector('#cfgPlanField');
    var planHint = pane.querySelector('#cfgPlanHint');

    // 把输入框里当前服务商的 key/model 存回 providers[curProvId]
    function saveCurProvider() {
      Store.setProviderConfig(curProvId, {
        apiKey: pane.querySelector('#cfgKey').value.trim(),
        model: pane.querySelector('#cfgModel').value.trim()
      });
    }

    // 百炼类服务商才显示「模型 / 计划」下拉，并同步提示文案
    function syncPlanField() {
      var prov = pane.querySelector('#cfgProvider').value;
      var list = planListFor(prov);
      planField.style.display = list ? '' : 'none';
      if (!list) return;
      var sel = pane.querySelector('#cfgPlan');
      var cur = pane.querySelector('#cfgModel').value.trim();
      sel.innerHTML = list.map(function (p) {
        return '<option value="' + esc(p.v) + '">' + esc(p.t) + '</option>';
      }).join('');
      var hit = false;
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === cur) { sel.selectedIndex = i; hit = true; break; }
      }
      if (!hit && !cur) sel.value = list[0].v;
      planHint.innerHTML = (prov === 'bailian_tokenplan')
        ? 'Qwen3.8-Max / 3.7-Plus / 3.8-Flash / 3.6-Flash 能看图；Qwen3.7-Max、GLM、DeepSeek 是纯文本模型，选它们讲题会失败。'
        : '不同模型对应不同额度与单价（Token Plan 用 sk-sp- 开头 Key）';
    }

    /* 按模型名判断是否支持图片输入：true 像能让看图 / false 实测不能 / null 判断不了 */
    var VISION_NAME = /vl|vision|omni|gpt-4o|gpt-4\.1|claude-3|gemini|glm-4v|qwen3\.|qwen3-/i;
    var TEXT_ONLY_NAME = /deepseek|qwen3\.7-max|glm-5|glm-4($|[^v])|audio|math|code/i;
    function visionLikely(m) {
      if (!m) return null;
      if (/glm-4v/i.test(m)) return true;
      if (TEXT_ONLY_NAME.test(m)) return false;
      if (VISION_NAME.test(m)) return true;
      return null;
    }
    function syncVisionHint() {
      var m = (pane.querySelector('#cfgModel').value || '').trim();
      var el = pane.querySelector('#cfgVisionHint');
      if (!m) { el.innerHTML = ''; return; }
      var v = visionLikely(m);
      if (v === true) {
        el.style.color = 'var(--ok)';
        el.innerHTML = '✅ 该模型支持图片输入，可用于错题分析';
      } else if (v === false) {
        el.style.color = 'var(--bad)';
        el.innerHTML = '❌ 实测这类模型是纯文本的，看不了图；请换带视觉的模型（如 Qwen3.8-Max、Qwen2.5-VL、qwen-vl-max、glm-4v）';
      } else {
        el.style.color = 'var(--warn)';
        el.innerHTML = '⚠️ 无法从模型名判断能否看图，建议点「测试连接」确认（能看图会返回图片内容，纯文本模型会说看不到）';
      }
    }

    pane.querySelector('#cfgProvider').addEventListener('change', function () {
      var next = this.value;
      if (next === curProvId) return;
      saveCurProvider();                       // 1) 先存回旧服务商的 key/model
      curProvId = next;
      var p = PROVIDERS[next];
      if (p.b) pane.querySelector('#cfgBase').value = p.b;
      // 2) 回填新服务商自己存的 key/model（没有则用该服务商默认模型，key 留空）
      var cfg = Store.providerConfig(next);
      var useKey = cfg.apiKey || '';
      var useModel = cfg.model || p.m || '';
      pane.querySelector('#cfgKey').value = useKey;
      pane.querySelector('#cfgModel').value = useModel;
      pane.querySelector('#cfgKey').placeholder = (next === 'bailian_tokenplan') ? 'sk-sp-...' : 'sk-...';
      // 3) 同步「当前生效值」，供错题分析读取
      Store.saveSettings({
        apiBase: pane.querySelector('#cfgBase').value.trim(),
        apiKey: useKey, model: useModel, currentProvider: next
      });
      syncPlanField();
      syncVisionHint();
      toast('已切换到 ' + p.n);
    });

    pane.querySelector('#cfgPlan').addEventListener('change', function () {
      pane.querySelector('#cfgModel').value = this.value;
      Store.saveSettings({ model: this.value });
      saveCurProvider();
      syncVisionHint();
      toast('已选择：' + this.options[this.selectedIndex].text);
    });

    // base / key / model 改动即时保存；key / model 同时写回当前服务商名下
    function bindInput(id, key) {
      pane.querySelector(id).addEventListener('change', function () {
        var v = this.value.trim();
        var patch = {}; patch[key] = v;
        Store.saveSettings(patch);
        if (key === 'apiKey' || key === 'model') saveCurProvider();
        if (id === '#cfgModel') { syncPlanField(); syncVisionHint(); }
        toast('已保存');
      });
    }
    bindInput('#cfgBase', 'apiBase');
    bindInput('#cfgKey', 'apiKey');
    bindInput('#cfgModel', 'model');

    pane.querySelector('#cfgThink').addEventListener('change', function () {
      Store.saveSettings({ deepThinking: this.checked });
      toast(this.checked ? '已开启深度思考（会明显变慢）' : '已关闭深度思考');
    });

    pane.querySelector('#btnTest').addEventListener('click', function () {
      var btn = this, old = btn.textContent;
      var cfg = {
        apiBase: pane.querySelector('#cfgBase').value.trim(),
        apiKey: pane.querySelector('#cfgKey').value.trim(),
        model: pane.querySelector('#cfgModel').value.trim()
      };
      btn.disabled = true;
      btn.textContent = '测试中…';
      AI.testConnection(cfg)
        .then(function () { toast('连接成功 ✅'); })
        .catch(function (e) { toast('失败：' + e.message, 3500); })
        .then(function () { btn.disabled = false; btn.textContent = old; });
    });

    pane.querySelector('#btnSaveCfg').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      saveCurProvider();
      Store.saveSettings({
        apiBase: pane.querySelector('#cfgBase').value.trim(),
        apiKey: pane.querySelector('#cfgKey').value.trim(),
        model: pane.querySelector('#cfgModel').value.trim(),
        currentProvider: curProvId
      }).then(function () {
        toast('设置已保存');
        btn.disabled = false;
      }).catch(function (e) {
        toast('保存失败：' + e.message);
        btn.disabled = false;
      });
    });

    syncPlanField();
    syncVisionHint();
  }

  /* =============== 注册登录页 + 右上角账号胶囊 ===============
   * 与参照项目 enStudy 同构：未登录只显示登录卡片（隐藏底部 tabbar），
   * 登录成功后由 app.js 的 Auth 事件接管，渲染各功能页。
   */
  function showLogin(target) {
    var tabbar = document.querySelector('.tabbar');
    if (tabbar) tabbar.style.display = 'none';

    target.innerHTML =
      '<div class="auth-wrap">' +
        '<div class="auth-card">' +
          '<div class="auth-hd">' +
            '<div class="auth-logo">📘</div>' +
            '<h2 class="auth-title">错题本</h2>' +
            '<p class="auth-sub">拍照记错题 · AI 讲题复盘</p>' +
          '</div>' +
          '<div class="auth-tabs">' +
            '<button class="auth-tab is-on" data-mode="login">登录</button>' +
            '<button class="auth-tab" data-mode="signup">注册</button>' +
          '</div>' +
          '<form class="auth-form" autocomplete="off">' +
            '<label class="auth-field">' +
              '<span class="auth-lbl">用户名 <em class="tiny muted">（英文字母开头，3-31 位）</em></span>' +
              '<input id="authUser" class="auth-input" type="text" maxlength="31" spellcheck="false" autocomplete="username" placeholder="例如 ding / xiaoming_2026" required>' +
            '</label>' +
            '<label class="auth-field">' +
              '<span class="auth-lbl">密码 <em class="tiny muted">（4-64 位）</em></span>' +
              '<input id="authPwd" class="auth-input" type="password" maxlength="64" autocomplete="current-password" placeholder="请输入密码" required>' +
            '</label>' +
            '<div id="authErr" class="auth-err" hidden></div>' +
            '<button id="authSubmit" class="btn full" type="submit">登录</button>' +
          '</form>' +
          '<p class="tiny muted" style="margin-top:16px;text-align:center">' +
            '首次使用？点上面「注册」创建账号，每个账号的错题相互独立。' +
          '</p>' +
        '</div>' +
      '</div>';

    var mode = 'login';          // 'login' | 'signup'
    var form = target.querySelector('.auth-form');
    var userInput = target.querySelector('#authUser');
    var pwdInput = target.querySelector('#authPwd');
    var submitBtn = target.querySelector('#authSubmit');
    var errBox = target.querySelector('#authErr');

    function setMode(m) {
      mode = m;
      Array.prototype.forEach.call(target.querySelectorAll('.auth-tab'), function (b) {
        b.classList.toggle('is-on', b.dataset.mode === m);
      });
      submitBtn.textContent = (m === 'login') ? '登录' : '注册并登录';
      pwdInput.setAttribute('autocomplete', m === 'login' ? 'current-password' : 'new-password');
      errBox.hidden = true;
      errBox.textContent = '';
    }
    function showError(msg) {
      errBox.textContent = msg || '';
      errBox.hidden = !msg;
    }

    Array.prototype.forEach.call(target.querySelectorAll('.auth-tab'), function (b) {
      b.addEventListener('click', function () { setMode(b.dataset.mode); });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var u = (userInput.value || '').trim();
      var p = pwdInput.value || '';
      if (!u) { showError('请输入用户名'); userInput.focus(); return; }
      if (!p) { showError('请输入密码'); pwdInput.focus(); return; }

      submitBtn.disabled = true;
      var oldText = submitBtn.textContent;
      submitBtn.textContent = (mode === 'login') ? '登录中...' : '注册中...';

      // 兜底：鉴权成功后若后续初始化链路异常会永久卡在「登录中...」，8 秒后恢复按钮
      var settled = false;
      var watchdog = setTimeout(function () {
        if (settled) return;
        settled = true;
        submitBtn.disabled = false;
        submitBtn.textContent = oldText;
        showError('登录响应超时，请重试（若持续出现请刷新页面）');
      }, 8000);

      var promise = (mode === 'login') ? Auth.login(u, p) : Auth.signup(u, p);
      promise.then(function (out) {
        settled = true; clearTimeout(watchdog);
        if (out.status === 200 && out.body && out.body.ok) {
          showError('');
          toast((mode === 'login' ? '欢迎回来 ' : '注册成功，') + u);
          // 后续由 Auth 事件触发 app.js 的登录流程
        } else {
          showError((out.body && out.body.error) || ('请求失败 (' + out.status + ')'));
          submitBtn.disabled = false;
          submitBtn.textContent = oldText;
        }
      }).catch(function () {
        settled = true; clearTimeout(watchdog);
        showError('网络错误，请重试');
        submitBtn.disabled = false;
        submitBtn.textContent = oldText;
      });
    });

    setTimeout(function () { userInput.focus(); }, 50);
  }

  // 已登录：恢复底部 tabbar（登录页会把它藏起来）
  function setAuthed() {
    var tabbar = document.querySelector('.tabbar');
    if (tabbar) tabbar.style.display = '';
    renderUserChip();
  }

  function closeUserPopover() {
    var p = document.getElementById('userPopover');
    if (p) p.remove();
  }

  // 右上角账号胶囊：未登录显示「登录」，已登录显示头像首字母 + 用户名，点开是账号菜单
  function renderUserChip() {
    var btn = document.getElementById('userBtn');
    if (!btn) return;
    closeUserPopover();

    var u = Auth.current();
    if (!u) {
      btn.className = 'user-chip';
      btn.innerHTML = '<span>登录</span>';
      btn.onclick = function () {
        var v = document.getElementById('view');
        if (v) showLogin(v);
      };
      return;
    }

    btn.className = 'user-chip';
    var initial = (u.username || '?').charAt(0).toUpperCase();
    btn.innerHTML =
      '<span class="user-avatar">' + esc(initial) + '</span>' +
      '<span class="user-name">' + esc(u.username) + '</span>' +
      '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    btn.onclick = function (e) {
      e.stopPropagation();
      if (document.getElementById('userPopover')) { closeUserPopover(); return; }

      var pop = document.createElement('div');
      pop.id = 'userPopover';
      pop.className = 'user-popover';
      var regAt = u.createdAt ? new Date(u.createdAt).toLocaleDateString('zh-CN') : '—';
      pop.innerHTML =
        '<div class="user-pop-hd">' +
          '<div class="user-pop-name">' + esc(u.username) + (u.role === 'admin' ? ' · 管理员' : '') + '</div>' +
          '<div class="user-pop-sub tiny muted">用户 ID #' + esc(u.id) + ' · 注册 ' + esc(regAt) + '</div>' +
        '</div>' +
        '<button class="user-pop-btn" data-act="change-pwd">🔑 修改密码</button>' +
        (u.role === 'admin' ? '<button class="user-pop-btn" data-act="reset-pwd">🔓 重置他人密码</button>' : '') +
        '<button class="user-pop-btn danger" data-act="logout">退出登录</button>';
      document.body.appendChild(pop);
      var r = btn.getBoundingClientRect();
      pop.style.top = (r.bottom + 6) + 'px';
      pop.style.right = Math.max(8, window.innerWidth - r.right) + 'px';

      pop.querySelector('[data-act="change-pwd"]').addEventListener('click', function () {
        closeUserPopover(); showChangePassword();
      });
      var resetBtn = pop.querySelector('[data-act="reset-pwd"]');
      if (resetBtn) resetBtn.addEventListener('click', function () {
        closeUserPopover(); showResetPassword();
      });
      pop.querySelector('[data-act="logout"]').addEventListener('click', function () {
        closeUserPopover();
        confirmBox('退出登录', '退出后本机不再显示你的错题（数据都在服务器上），下次用同一账号登录即可看到。', function () {
          Auth.logout();
        });
      });

      setTimeout(function () {
        document.addEventListener('click', function close(ev) {
          if (!ev.target.closest('#userPopover') && !ev.target.closest('#userBtn')) {
            closeUserPopover();
            document.removeEventListener('click', close);
          }
        });
      }, 0);
    };
  }

  function bindUserChip() {
    if (document.getElementById('userBtn')) renderUserChip();
  }

  /* 修改密码：需原密码 + 新密码两次一致 */
  function showChangePassword() {
    sheet('修改密码',
      '<div class="auth-field"><span class="auth-lbl">当前密码</span>' +
        '<input id="cpOld" class="auth-input" type="password" maxlength="64" autocomplete="current-password" placeholder="请输入当前密码"></div>' +
      '<div class="auth-field" style="margin-top:12px"><span class="auth-lbl">新密码 <em class="tiny muted">（4-64 位）</em></span>' +
        '<input id="cpNew" class="auth-input" type="password" maxlength="64" autocomplete="new-password" placeholder="请输入新密码"></div>' +
      '<div class="auth-field" style="margin-top:12px"><span class="auth-lbl">确认新密码</span>' +
        '<input id="cpNew2" class="auth-input" type="password" maxlength="64" autocomplete="new-password" placeholder="再次输入新密码"></div>' +
      '<div id="cpErr" class="auth-err" style="margin-top:12px" hidden></div>' +
      '<button class="btn full" id="cpOk" style="margin-top:16px">保存新密码</button>',
      function (bd) {
        var err = bd.querySelector('#cpErr');
        function fail(m) { err.textContent = m; err.hidden = false; }
        bd.querySelector('#cpOk').addEventListener('click', function () {
          var btn = this;
          var oldP = bd.querySelector('#cpOld').value;
          var newP = bd.querySelector('#cpNew').value;
          var newP2 = bd.querySelector('#cpNew2').value;
          err.hidden = true;
          if (!oldP) return fail('请输入当前密码');
          if (newP.length < 4 || newP.length > 64) return fail('新密码需 4-64 位');
          if (newP !== newP2) return fail('两次输入的新密码不一致');
          btn.disabled = true; btn.textContent = '保存中…';
          Auth.changePassword(oldP, newP).then(function (out) {
            btn.disabled = false; btn.textContent = '保存新密码';
            if (out.status === 200 && out.body && out.body.ok) {
              closeSheet(); toast('密码已修改');
            } else {
              fail((out.body && out.body.error) || ('修改失败 (' + out.status + ')'));
            }
          }).catch(function () {
            btn.disabled = false; btn.textContent = '保存新密码';
            fail('网络错误，请重试');
          });
        });
      });
  }

  /* 管理员：重置指定用户密码（无需原密码） */
  function showResetPassword() {
    Auth.listUsers().then(function (out) {
      if (!(out.status === 200 && out.body && out.body.ok)) {
        return toast((out.body && out.body.error) || '无法获取用户列表');
      }
      var users = out.body.users || [];
      var me = Auth.current() || {};
      var opts = users.map(function (u) {
        return '<option value="' + esc(u.id) + '"' + (u.id === me.id ? ' selected' : '') + '>' +
          esc(u.username) + (u.role === 'admin' ? '（管理员）' : '') + ' · #' + esc(u.id) + '</option>';
      }).join('');

      sheet('重置用户密码',
        '<div class="field"><label>选择用户</label><select class="input" id="rpUser">' + opts + '</select></div>' +
        '<div class="auth-field"><span class="auth-lbl">新密码 <em class="tiny muted">（4-64 位）</em></span>' +
          '<input id="rpNew" class="auth-input" type="password" maxlength="64" autocomplete="new-password" placeholder="请输入新密码"></div>' +
        '<div id="rpErr" class="auth-err" style="margin-top:12px" hidden></div>' +
        '<button class="btn full" id="rpOk" style="margin-top:16px">重置密码</button>' +
        '<div class="hint" style="margin-top:10px">重置后对方需用新密码登录；管理员无需知道对方原密码。</div>',
        function (bd) {
          var err = bd.querySelector('#rpErr');
          bd.querySelector('#rpOk').addEventListener('click', function () {
            var btn = this;
            var id = Number(bd.querySelector('#rpUser').value);
            var np = bd.querySelector('#rpNew').value;
            err.hidden = true;
            if (np.length < 4 || np.length > 64) { err.textContent = '新密码需 4-64 位'; err.hidden = false; return; }
            btn.disabled = true; btn.textContent = '重置中…';
            Auth.resetPassword(id, np).then(function (out) {
              btn.disabled = false; btn.textContent = '重置密码';
              if (out.status === 200 && out.body && out.body.ok) { closeSheet(); toast('密码已重置'); }
              else { err.textContent = (out.body && out.body.error) || ('重置失败 (' + out.status + ')'); err.hidden = false; }
            }).catch(function () {
              btn.disabled = false; btn.textContent = '重置密码';
              err.textContent = '网络错误，请重试'; err.hidden = false;
            });
          });
        });
    });
  }

  return {
    esc: esc, toast: toast, sheet: sheet, closeSheet: closeSheet, confirmBox: confirmBox,
    compress: compress, fmtDate: fmtDate,
    renderCapture: renderCapture, captureSetImage: captureSetImage,
    captureAddImage: captureAddImage, captureReset: captureReset,
    renderBook: renderBook, renderStats: renderStats, openDetail: openDetail,
    pickSolutionImage: pickSolutionImage, solutionImagePicked: solutionImagePicked,
    showLogin: showLogin, setAuthed: setAuthed, renderUserChip: renderUserChip, bindUserChip: bindUserChip,
    showChangePassword: showChangePassword, showResetPassword: showResetPassword
  };
})();
