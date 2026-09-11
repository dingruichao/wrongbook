/* 注册登录模块（与参照项目 enStudy 的 js/auth.js 同构）
 * 流程：
 *   1. Auth.me()         启动时调用，确认 cookie 是否有效
 *   2. Auth.signup(...)  POST /api/auth/register；成功后自动登录
 *   3. Auth.login(...)   POST /api/auth/login
 *   4. Auth.logout()     POST /api/auth/logout，清 cookie
 *   5. Auth.on(fn)       订阅 login / logout 事件
 * 服务端返回的用户对象：{ id, username, createdAt, role }（role: 'admin' | 'user'）
 *
 * 登录态放在 HttpOnly Cookie 里，前端拿不到也改不了，只能通过 /api/auth/me 反查。
 */
window.Auth = (function () {
  var user = null;
  var listeners = [];

  function emit(ev) {
    listeners.slice().forEach(function (fn) {
      try { fn(ev); } catch (e) {
        // 不能静默吞：订阅方抛错会导致登录后不跳转，界面永久卡在「登录中...」而无任何线索
        if (window.console && console.error) console.error('[Auth] 订阅回调抛错 (' + ev.type + '):', e);
      }
    });
  }

  function parseResp(r) {
    return r.json().then(function (j) { return { status: r.status, body: j }; });
  }

  function pick(body) {
    return { id: body.userId, username: body.username, createdAt: body.createdAt, role: body.role };
  }

  function me() {
    return fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(parseResp)
      .then(function (out) {
        if (out.status === 200 && out.body && out.body.ok) {
          user = pick(out.body);
          emit({ type: 'login', user: user });
          return user;
        }
        user = null;
        emit({ type: 'logout' });
        return null;
      })
      .catch(function () { user = null; emit({ type: 'logout' }); return null; });
  }

  function login(username, password) {
    return fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    })
      .then(parseResp)
      .then(function (out) {
        if (out.status === 200 && out.body && out.body.ok) {
          user = pick(out.body);
          emit({ type: 'login', user: user });
        } else { user = null; }
        return out;
      });
  }

  function signup(username, password) {
    return fetch('/api/auth/register', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    })
      .then(parseResp)
      .then(function (out) {
        if (out.status === 200 && out.body && out.body.ok) {
          user = pick(out.body);
          emit({ type: 'login', user: user });
        }
        return out;
      });
  }

  function logout() {
    return fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
      .then(parseResp)
      .catch(function () { return { status: 500, body: { error: 'network' } }; })
      .then(function (out) {
        user = null;
        emit({ type: 'logout' });
        return out;
      });
  }

  function changePassword(oldPassword, newPassword) {
    return fetch('/api/auth/change-password', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: oldPassword, newPassword: newPassword })
    }).then(parseResp);
  }

  // 管理员：列出所有用户（供「重置密码」下拉框）
  function listUsers() {
    return fetch('/api/auth/users', { credentials: 'same-origin', cache: 'no-store' }).then(parseResp);
  }

  // 管理员：重置指定用户密码（无需原密码）
  function resetPassword(targetUserId, newPassword) {
    return fetch('/api/auth/reset-password', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserId: targetUserId, newPassword: newPassword })
    }).then(parseResp);
  }

  function current() { return user; }
  function on(fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }

  return {
    me: me, login: login, signup: signup, logout: logout,
    changePassword: changePassword, listUsers: listUsers, resetPassword: resetPassword,
    current: current, on: on
  };
})();
