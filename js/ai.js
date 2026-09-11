/* AI 模块：调用视觉大模型分析错题图片（OpenAI 兼容接口，经服务端 /api/ai/chat 代理转发）
 *
 * 为什么走服务端代理：
 *   1) 浏览器直连各家大模型会有 CORS 限制；
 *   2) API Key 不落在前端请求里，只由服务端转发时使用。
 *
 * 图片以 data:image/*;base64 放进 image_url，因此任何 OpenAI 兼容的多模态模型都能用，
 * 例如：Qwen2.5-VL（硅基流动/阿里百炼）、GLM-4V（智谱）、GPT-4o（OpenAI）。
 */
window.AI = (function () {

  /* 提示词：融合了三个教育 skill 的方法论
   *   1) agent-question-explanation（AI 讲题）：题意确认 → 关键思路 → 分步讲解 → 为什么这样做
   *      → 易错提醒 → 同类小练。本文件里的 why（为什么这样做）与 steps（分步讲解，每步带依据）
   *      两块就是照它的输出格式来的；
   *   2) photo-question-tutor（拍照答疑）：识题 → 条件·目标·方法·步骤讲解 → 易错提醒 → 同类变式题，
   *      硬性要求「不得只输出答案」「识别不确定必须标注」「讲解匹配年级」；
   *   3) agent-mistake-review（错题复盘）：判错因 → 一句话订正 → 同类题 → 间隔复习安排，
   *      硬性要求「错因必须基于学生原答案与正确解法的差异」「避免一律归为粗心」「复习动作可执行」。
   * note：录入时写的备注，通常写「第几题」，也可能写了自己当时的答案，一并交给模型。 */
  function buildPrompt(subject, grade, note) {
    var subj = subject === 'physics' ? '物理' : '数学';
    var gradeName = Store.gradeName(grade);
    var n = note ? String(note).trim() : '';

    var extra = subject === 'physics'
      ? '物理题先讲清物理过程与状态变化，再列公式及其适用条件，注意单位换算与矢量方向。'
      : '数学题写清推导，分类讨论要分情况说明，几何题点出关键辅助线或定理。';

    var notePart = n
      ? '学生备注：「' + n + '」（多为题号，只处理这道题；若含「我答的是 X」即为学生原答案；备注与图片对不上时处理图中最主要的那道题，并把 uncertain 置为 true）。'
      : '（本条没有备注，请自行从图中判断题号与作答痕迹。）';

    /* ⚠️ 这份提示词的两条「铁律」是实测出来的，不要删：
     *   - 推理模型（qwen3.x-max/plus）遇到「自算答案与图中标注答案不一致」的题会陷入
     *     「让我重新看 → 不对 → 再假设」的死循环，把 max_tokens 全部烧光导致输出被截断
     *     （实测 4000 token 全用于自我推翻，返回的内容无法解析）。
     *   - 加上「最多复核一次 + 不一致就标 uncertain」后，同一张图 26s 正常收敛（finish=stop）。
     *   - 字段顺序也别改：把 steps 放最后，万一被截断，丢掉的只是步骤而不是答案。
     *   - why（为什么这样做）是短字段但教学价值最高，所以排在 answer 紧后面 —— 即使
     *     输出被截断，先丢的也永远是末尾的 steps，不会丢 why。 */
    return '你是初中' + subj + '老师，学生拍了这张' + gradeName + subj + '错题照片。请直接下结论并讲解。\n' +
      notePart + '\n\n' +
      '【铁律 · 违反即失败】\n' +
      'A. 只输出一个 JSON，前后不加任何文字，不加 markdown 代码块。\n' +
      'B. 看图最多复核一次。若你的计算结果与图中标注的答案不一致，不要反复重算：' +
      '直接写出你的结论，把 uncertain 设为 true，并在 causeDetail 里写「自算结果与题目标注答案不一致」。\n' +
      'C. 严禁出现「让我再看」「等等」「不对」「重新看」「再假设」「再试一次」这类自我怀疑、反复推翻的字句。\n' +
      'D. why 是「为什么这样做」：2-3 句，讲清这道题为什么用这个方法、怎么想到的，不超过 120 字。\n' +
      'E. steps 是「分步讲解」：3-5 步，每步写清「做什么 + 为什么这么做（依据）」，每步不超过 60 字。\n' +
      'F. 全文不超过 800 字。写完 JSON 立即停止。\n\n' +
      '【讲解要求】\n' +
      '· 不许只给答案，讲解要匹配' + gradeName + '水平。' + extra + '\n' +
      '· 错因必须基于「学生原答案」与正确解法的差异，不许一律归为粗心；看不出学生作答时，' +
      '按这类题最常见的错误归因，并在 causeDetail 里注明「未看到学生作答痕迹，按常见错误推断」。\n' +
      '· 复习动作要可执行（reviewDays 给具体天数）。\n\n' +
      '【字段说明】\n' +
      'question 题目(含已知与所求)；studentAnswer 学生原答案(看不出填空串)；answer 正确答案；\n' +
      'why 为什么这样做(这类题该用哪个方法、为什么、从哪句话能想到，讲方法选择的道理，不写具体计算)；\n' +
      'steps 分步讲解(每步写清做什么和依据，按先后顺序，不写自我推敲)；\n' +
      'knowledge 考查知识点；causeType 从「概念不清|公式用错|计算失误|审题漏条件|步骤跳步|单位换算|其它」中选一个；\n' +
      'causeDetail 错因判断依据；fixOneLine 一句话订正；tip 易错点提醒；\n' +
      'similar 同类变式题(换数字或换问法，难度相当){q题干,a参考答案,hint提示}；\n' +
      'reviewDays 几天后重做(整数)；reviewFocus 重做重点；uncertain 布尔。\n\n' +
      '【输出模板 · 字段顺序照抄】\n' +
      '{"question":"","studentAnswer":"","answer":"","why":"","knowledge":"","causeType":"","causeDetail":"",' +
      '"fixOneLine":"","tip":"","similar":{"q":"","a":"","hint":""},"reviewDays":3,"reviewFocus":"","uncertain":false,"steps":["","",""]}\n\n' +
      '若图片里没有清晰的题目，仍返回上述 JSON：question 填「未能识别题目」，answer 填「无法判断」，uncertain 置为 true。';
  }

  /* 从模型回复里稳健地提取 JSON（模型常会包一层 ```json 或前后带说明文字） */
  function extractJSON(text) {
    if (!text) return null;
    var s = String(text).trim();
    // 去掉 markdown 代码块围栏
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    // 优先尝试整体解析
    try { return JSON.parse(s); } catch (e) { }
    // 截取第一个 { 到最后一个 }
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      var frag = s.slice(a, b + 1);
      try { return JSON.parse(frag); } catch (e) { }
      // 尝试修复：去掉控制字符
      try { return JSON.parse(frag.replace(/[\x00-\x1f\x7f]/g, ' ')); } catch (e2) { }
    }
    return null;
  }

  /* 模型的输出被 max_tokens 截断时，整段 JSON 不合法、JSON.parse 会整体失败。
   * 这里按字段逐个正则抢救，能救回多少算多少——总比让用户看到一片空白强。 */
  function salvageJSON(text) {
    if (!text) return null;
    var s = String(text), out = {}, any = false;
    function str(key) {
      var m = s.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
      if (!m) return undefined;
      any = true;
      try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; }
    }
    ['question', 'studentAnswer', 'answer', 'why', 'knowledge', 'causeType',
      'causeDetail', 'fixOneLine', 'tip', 'reviewFocus'].forEach(function (k) {
        var v = str(k);
        if (v !== undefined) out[k] = v;
      });
    var q = str('q'), a = str('a'), h = str('hint');
    if (q !== undefined || a !== undefined || h !== undefined) {
      out.similar = { q: q || '', a: a || '', hint: h || '' };
    }
    var ms = s.match(/"steps"\s*:\s*\[([\s\S]*)$/);
    if (ms) {
      var items = ms[1].match(/"(?:[^"\\]|\\.)*"/g) || [];
      if (items.length) {
        any = true;
        out.steps = items.map(function (x) {
          try { return JSON.parse(x); } catch (e) { return x.slice(1, -1); }
        });
      }
    }
    var rd = s.match(/"reviewDays"\s*:\s*(\d+)/);
    if (rd) { out.reviewDays = Number(rd[1]); any = true; }
    var un = s.match(/"uncertain"\s*:\s*(true|false)/);
    if (un) { out.uncertain = un[1] === 'true'; any = true; }
    return any ? out : null;
  }

  /* 模型自问自答 / 反复推翻的痕迹（推理模型读不清图时的典型表现）。
   *
   * 原来一个正则搞定，但 v3 把 steps 升级成「分步讲解」——每步要写清依据，于是
   * 「假设…则受力平衡」「这意味着…」「如果是 …」这类完全合法的物理 / 数学语言
   * 会出现，原正则会把它们和自我推翻一起丢掉。所以拆成两档：
   *   - 强信号：一眼就是自我怀疑（让我再看/等等/不对/重新看/复核/我算错 等），见到就丢；
   *   - 弱信号：在正经讲解里也合法（假设/意味着/这说明/尝试 等），撞到 ≥2 个才算推敲。
   * 宁可多留一两个可疑步骤、并在 quality 上标 partial，让用户看到「分析仅供参考」，
   * 也不要因为正则太严把好步骤一起干掉。 */
  var META_STRONG_RE = /(让我(再|重新)?(看|想|算|确认|检查|一眼)|我们(来|再)|等等|不对(了|吧)?[，。、,!！]|重新(看|算|想|检查|来)|再次(看|算|复核|检查)|复核|破局|我(算|看|想|读)错|不可能)/;
  var META_WEAK_SRC = '(假设|如果是|如果这样|意味着|这说明|是不是|尝试|修正|隔断了|对不对|[?？])';
  var META_WEAK_RE = new RegExp(META_WEAK_SRC);
  var META_WEAK_COUNT_RE = new RegExp(META_WEAK_SRC, 'g');

  /* 一条文本是否判定为「模型的自我推翻 / 自问自答」 */
  function looksLikeMeta(t) {
    if (META_STRONG_RE.test(t)) return true;
    return (t.match(META_WEAK_COUNT_RE) || []).length >= 2;
  }

  /* 一道题的分步讲解，模型给到 3-5 步就够了。给出十几条以上的（实测跑飞能到 178 条），
   * 一定是把「想的过程」当步骤写了——这时不看内容，整段丢弃比逐条筛更可靠。
   * 这一道线比任何关键词正则都顶用，因为它抓的是「数量这个结构性信号」。 */
  var STEPS_MAX = 10;

  /* 清洗 steps：去掉模型混进来的思考过程，修掉重复的行首序号，限制条数与字数 */
  function sanitizeSteps(steps) {
    if (!Array.isArray(steps)) return [];
    if (steps.length > STEPS_MAX) return [];
    var out = [];
    steps.forEach(function (s) {
      var t = String(s == null ? '' : s).trim();
      if (!t) return;
      // 模型既用数组下标、又在字符串里写了一遍「1. 」/「第一步：」
      t = t.replace(/^\s*(?:第\s*)?[0-9一二三四五六七八九十]{1,3}\s*(?:步\s*[：:.]?|[.、,，:：)）])\s*/, '');
      t = t.replace(/^[：:、,，.。]\s*/, '');        // 剥掉残留的「：」
      if (!t) return;
      if (looksLikeMeta(t)) return;                // 自我怀疑 / 自问自答的句子直接丢掉
      if (t.length > 120) t = t.slice(0, 120) + '…';
      out.push(t);
    });
    return out.slice(0, 6);
  }

  /* messages: 消息数组；opts: { max_tokens, temperature, thinking }；cfgOverride: 可选，
   * 传了就用它替代 Store 里的设置（设置页「测试连接」时，输入框里可能还没保存）
   *
   * 关于思考开关：qwen3.x-max / qwen3.7-plus 这类推理模型默认会先"想"几十秒（实测读一张图要 40s+），
   * 读图讲题这种任务不需要那么久，默认让服务端带上 enable_thinking:false（实测 2s 内返回，且照常看得懂图）。
   * 想要更严谨的推演，可在设置页打开「深度思考」。 */
  function chat(messages, opts, cfgOverride) {
    var st = cfgOverride || Store.getSettings();
    opts = opts || {};
    if (!st.apiBase || !st.apiKey) {
      return Promise.reject(new Error('尚未配置大模型接口，请到「设置」填写 API Base / Key / 模型名'));
    }
    var thinking = (opts.thinking != null) ? !!opts.thinking : !!st.deepThinking;
    return fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiBase: st.apiBase,
        apiKey: st.apiKey,
        model: st.model,
        messages: messages,
        max_tokens: opts.max_tokens || 2048,
        temperature: opts.temperature != null ? opts.temperature : 0.2,
        enable_thinking: thinking            // false = 关闭思考（服务端只转发 false，不传 true）
      })
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { }
        if (!r.ok) {
          var msg = (j && (j.error && j.error.message || j.error)) || t.slice(0, 300);
          throw new Error('接口返回 ' + r.status + '：' + msg);
        }
        if (!j) throw new Error('上游返回非 JSON：' + t.slice(0, 200));
        return j;
      });
    });
  }

  /* 「二次识别」提示词：只问关键字段、不要步骤。
   * 为什么要这样：第一次跑飞时，问题往往出在「长输出」——模型在 steps 里反复自我推翻把额度烧光。
   * 这里把输出压到几个短字段（实测几十 token 就能答完），模型没有空间跑飞，因此几乎不会失败；
   * 步骤仍然用第一次抢救回来的内容，答案/题目/知识点/why 用这次的结果覆盖，取长补短。 */
  function buildRetryPrompt(subject, grade, note) {
    var subj = subject === 'physics' ? '物理' : '数学';
    var n = note ? String(note).trim() : '';
    return '你是初中' + subj + '老师。看这张' + Store.gradeName(grade) + subj + '错题照片，' +
      '只输出一个 JSON，不要任何解释文字、不要代码块、不要解题步骤。\n' +
      (n ? '学生备注：「' + n + '」，只处理这道题。\n' : '') +
      '不要写「让我」「等等」「不对」「再假设」这类句子。若看不清或不确定，把 uncertain 设为 true，answer 给出最可能的答案。\n' +
      '{"question":"题目(含已知与所求)","studentAnswer":"学生原答案(看不出填空串)","answer":"正确答案",' +
      '"why":"为什么这样做(2句以内)","knowledge":"考查知识点","uncertain":false}';
  }

  /* 跑一次：调模型 → 解析（失败则抢救）→ 产出带质量标记的结果 */
  function runOnce(messages, opts) {
    return chat(messages, opts).then(function (j) {
      var content = '', finish = '';
      try {
        var ch = (j.choices && j.choices[0]) || {};
        content = (ch.message && ch.message.content) || '';
        finish = ch.finish_reason || '';
      } catch (e) { }
      if (!content) throw new Error('模型未返回内容：' + JSON.stringify(j).slice(0, 300));

      var truncated = finish === 'length';
      var parsed = extractJSON(content);
      var salvaged = false;
      if (!parsed) { parsed = salvageJSON(content); salvaged = !!parsed; }

      var sim = (parsed && parsed.similar && typeof parsed.similar === 'object') ? parsed.similar : null;
      var rd = parsed && parsed.reviewDays;
      var rawSteps = (parsed && Array.isArray(parsed.steps)) ? parsed.steps : [];
      var steps = sanitizeSteps(rawSteps);
      /* 如果模型的步骤里绝大多数都是自我推敲（实测跑飞时 steps 能塞到 178 条），
       * 那剩下的几条也不可信 —— 整段丢掉，别拿推敲残渣冒充解题步骤。 */
      var stepsDropped = rawSteps.length - steps.length;
      if (rawSteps.length > 4 && steps.length / rawSteps.length < 0.5) steps = [];

      /* 清洗 why：单段正文更长，所以弱信号阈值比 steps 略松（撞到 ≥3 才丢）。 */
      var whyRaw = String((parsed && parsed.why) || '').trim();
      var why = whyRaw, whyDropped = false;
      if (why) {
        if (META_STRONG_RE.test(why) || (why.match(META_WEAK_COUNT_RE) || []).length >= 3) {
          why = ''; whyDropped = true;
        } else if (why.length > 300) {
          why = why.slice(0, 300) + '…';
        }
      }

      /* 质量自检：模型跑飞时（截断 / 解析失败 / 步骤全是自我推翻）不假装成功，
       * 把问题记下来交给界面提示用户「重新分析」。 */
      var warnings = [];
      if (salvaged) warnings.push('模型输出被截断，已尽量提取可用内容');
      else if (!parsed) warnings.push('模型返回的内容不是合法 JSON');
      else if (truncated) warnings.push('模型输出被长度上限截断，内容可能不完整');
      if (stepsDropped > 0) {
        warnings.push(!steps.length
          ? (rawSteps.length > STEPS_MAX
            ? '模型这次的步骤里混了大量自我推敲（共 ' + rawSteps.length + ' 条），已不展示'
            : '模型这次的解题步骤基本是自我推敲，已不展示')
          : '已自动过滤 ' + stepsDropped + ' 条模型的思考过程');
      }
      if (whyDropped) warnings.push('「为什么这样做」这段模型讲得反复不定，已隐藏');
      var answer = (parsed && parsed.answer) || '';
      if (parsed && !String(answer).trim()) warnings.push('未识别出答案');
      if (parsed && !steps.length && !stepsDropped) warnings.push('未能给出解题步骤');
      var quality = !parsed ? 'low'
        : ((truncated || salvaged || !String(answer).trim() || !steps.length) ? 'partial'
          : (warnings.length ? 'partial' : 'good'));

      var result = {
        schema: 'v3',                 // v3 = 加「为什么这样做」+ steps 升级为「分步讲解，每步含依据」（v1/v2 前端兼容）
        question: (parsed && parsed.question) || '',
        studentAnswer: (parsed && parsed.studentAnswer) || '',
        answer: answer,
        why: why,
        steps: steps,
        knowledge: (parsed && parsed.knowledge) || '',
        causeType: (parsed && parsed.causeType) || '',
        causeDetail: (parsed && parsed.causeDetail) || '',
        fixOneLine: (parsed && parsed.fixOneLine) || '',
        tip: (parsed && parsed.tip) || '',
        similar: sim ? { q: sim.q || '', a: sim.a || '', hint: sim.hint || '' } : null,
        reviewDays: (typeof rd === 'number' && rd > 0) ? rd : (rd && Number(rd) > 0 ? Number(rd) : 0),
        reviewFocus: (parsed && parsed.reviewFocus) || '',
        uncertain: !!(parsed && parsed.uncertain),
        quality: quality,             // good | partial | low
        warnings: warnings,
        finishReason: finish,
        raw: content,
        model: (Store.getSettings() || {}).model || '',
        noteUsed: opts && opts.note ? String(opts.note).trim() : '',   // 本次分析用的备注，便于回看
        analyzedAt: Date.now()
      };
      if (!parsed) {
        // 彻底解析失败也保留原文，界面会退化展示原始文本
        result.answer = content.slice(0, 500);
        result._unparsed = true;
      }
      return result;
    });
  }

  /* 分析一张错题图片（imageDataURL 为 data:image/...;base64 或 /uploads/xxx.jpg）
   * note 会拼进提示词一起发给模型，用于在一图多题时锁定「第几题」。
   * 第一次不完美（quality != good）时会再做一次「只要答案」的快速识别，把题目/答案/知识点补全。 */
  function analyze(imageDataURL, subject, grade, note) {
    // 若传的是图片路径而非 dataURL，先转成 dataURL，保证上游一定能读到图
    return toDataURL(imageDataURL).then(function (dataUrl) {
      function msgs(prompt) {
        return [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: prompt }
          ]
        }];
      }
      // 输出变长了（多了错因 / 同类题 / 复习建议），给足 token；
      // 开着深度思考时思考过程也占额度，再放宽一截
      var deep = !!(Store.getSettings() || {}).deepThinking;
      return runOnce(msgs(buildPrompt(subject, grade, note)), { max_tokens: deep ? 8000 : 4000, note: note })
        .then(function (r) {
          if (r.quality === 'good') return r;     // 一次到位，不再多花一次调用
          return runOnce(msgs(buildRetryPrompt(subject, grade, note)), { max_tokens: 800, note: note })
            .then(function (r2) {
              if (!String(r2.answer || '').trim()) {
                r.warnings = (r.warnings || []).concat('二次识别也没读出答案，建议重新分析或换一个模型');
                return r;
              }
              // 取长补短：讲解内容（why / steps / 错因等）用第一次的，题目/答案/知识点/why 用第二次（更可靠）的
              var m = {};
              for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) m[k] = r[k];
              m.question = r2.question || r.question;
              m.studentAnswer = r2.studentAnswer || r.studentAnswer;
              m.answer = r2.answer;
              m.knowledge = r2.knowledge || r.knowledge;
              m.why = (r.why && r.why.length) ? r.why : (r2.why || r.why || '');
              m.uncertain = !!(r.uncertain || r2.uncertain);
              m.quality = 'partial';
              delete m._unparsed;
              m.warnings = (r.warnings || []).concat(
                (r.steps && r.steps.length)
                  ? '题目与答案已由二次快速识别校正，解题步骤来自第一次识别'
                  : '题目与答案已由二次快速识别校正；本次没能给出解题步骤'
              );
              return m;
            })
            .catch(function () { return r; });   // 二次识别失败就退回第一次的结果
        });
    });
  }

  /* 把 /uploads/xx.jpg 或 http 图片转成 dataURL（用于回看已存错题的再次分析） */
  function toDataURL(src) {
    if (/^data:/i.test(src)) return Promise.resolve(src);
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          var cv = document.createElement('canvas');
          var maxSide = 1280;
          var w = img.width, h = img.height;
          var scale = Math.min(1, maxSide / Math.max(w, h));
          cv.width = Math.round(w * scale);
          cv.height = Math.round(h * scale);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          resolve(cv.toDataURL('image/jpeg', 0.85));
        } catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error('图片加载失败：' + src)); };
      img.src = src;
    });
  }

  /* 测试连接：发一条极短消息，能通就说明 base / key / 模型可用（不消耗多少额度） */
  function testConnection(cfg) {
    return chat([{ role: 'user', content: 'hi' }], { max_tokens: 8 }, cfg)
      .then(function () { return true; });
  }

  return {
    analyze: analyze, chat: chat, testConnection: testConnection,
    extractJSON: extractJSON, salvageJSON: salvageJSON, sanitizeSteps: sanitizeSteps,
    toDataURL: toDataURL, buildPrompt: buildPrompt, buildRetryPrompt: buildRetryPrompt
  };
})();
