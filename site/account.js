/* The store account: sign-in screen, "Create store profile" on first run, and the Account menu.
   One shared username + password for the whole store (kept as a salted hash in the Sheet's Account tab).
   A device stays signed in for years: its random session token lives in localStorage, and we ask Chrome to treat
   this site's storage as persistent so it isn't cleared to free space. Needs app.js (post, api, ls, esc, toast). */

let signInPromise = null;

function signIn(setup) {
  if (signInPromise) return signInPromise;
  signInPromise = new Promise(resolve => {
    const el = document.createElement('div');
    el.id = 'signin'; el.className = 'modal signin';
    const show = mode => {
      const make = mode === 'setup';
      el.innerHTML = `<form class="box" method="post" autocomplete="on">
        <div style="text-align:center"><img src="logo.png" alt="" style="height:64px"></div>
        <h2 style="text-align:center">${make ? 'Create the store profile' : 'Sign in'}</h2>
        <p class="hint" style="margin:0 0 6px">${make
          ? 'There is no store profile yet. Pick the username and password everyone at the store will use. Create it now, before anyone else opens the app.'
          : 'Use the store username and password. This computer stays signed in.'}</p>
        <label>Username<input name="username" autocomplete="username" value="${esc(ls.get('lastuser'))}" required></label>
        <label>Password<input name="password" type="password" autocomplete="${make ? 'new-password' : 'current-password'}" required></label>
        ${make ? '<label>Password again<input name="password2" type="password" autocomplete="new-password" required></label><p class="hint" style="margin:0">Any password works: any length, any characters.</p>' : ''}
        <div class="err sierr" role="alert" style="min-height:18px"></div>
        <button class="primary" type="submit" style="width:100%">${make ? 'Create store profile' : 'Sign in'}</button>
      </form>`;
      const f = el.querySelector('form'), err = el.querySelector('.sierr'), btn = f.querySelector('button');
      f.addEventListener('submit', async ev => {
        ev.preventDefault(); err.textContent = '';
        const u = f.username.value.trim(), p = f.password.value;
        if (make && p !== f.password2.value) { err.textContent = 'The two passwords are different'; return; }
        btn.disabled = true; btn.textContent = make ? 'Creating…' : 'Signing in…';
        try {
          const j = await post(make ? 'setup' : 'login', { username: u, password: p, token: '' });
          if (j.needLogin && j.setup && !make) { show('setup'); return; }
          if (!j.ok) throw new Error(j.error || 'That did not work');
          ls.set('session', j.token); ls.set('acctuser', j.username); ls.set('lastuser', j.username);
          S.who = j.username; showAccountName();
          try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
          el.remove(); resolve();
        } catch (e) {
          err.textContent = e.message; btn.disabled = false; btn.textContent = make ? 'Create store profile' : 'Sign in';
        }
      });
      setTimeout(() => (f.username.value ? f.password : f.username).focus(), 50);
    };
    document.body.appendChild(el);
    show(setup ? 'setup' : 'login');
  });
  signInPromise.then(() => { signInPromise = null; });
  return signInPromise;
}

/* ---------- Account menu ---------- */
function openAccount() {
  let m = document.getElementById('acct');
  if (m) m.remove();
  m = document.createElement('div'); m.id = 'acct'; m.className = 'modal';
  m.innerHTML = `<div class="box" role="dialog" aria-label="Account">
    <h2>Account</h2>
    <p class="hint" style="margin:0 0 8px">Signed in as <b>${esc(ls.get('acctuser') || 'the store')}</b>. This computer stays signed in until you sign out.</p>
    <details><summary><b>Change password</b></summary>
      <form id="pwform" class="signin" style="margin-top:6px">
        <label>Current password<input name="old" type="password" autocomplete="current-password" required></label>
        <label>New password<input name="n1" type="password" autocomplete="new-password" required></label>
        <label>New password again<input name="n2" type="password" autocomplete="new-password" required></label>
        <div class="err" id="pwerr" style="min-height:18px"></div>
        <button class="primary" type="submit">Change password</button>
        <p class="hint" style="margin:6px 0 0">Every other computer is signed out and must sign in again.</p>
      </form></details>
    <div class="row" style="justify-content:space-between;margin-top:14px"><button id="signout">Sign out</button><button id="acctclose" class="primary">Close</button></div>
  </div>`;
  document.body.appendChild(m);
  const $m = s => m.querySelector(s);
  $m('#acctclose').onclick = () => m.remove();
  m.addEventListener('click', e => { if (e.target === m) m.remove(); });
  $m('#signout').onclick = async () => {
    try { await post('logout', {}); } catch (e) {}
    ls.set('session', ''); location.reload();
  };
  $m('#pwform').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.target, err = $m('#pwerr'); err.textContent = '';
    if (f.n1.value !== f.n2.value) { err.textContent = 'The two new passwords are different'; return; }
    try {
      const j = await api('changePassword', { password: f.old.value, newPassword: f.n1.value });
      ls.set('session', j.token); m.remove(); toast('Password changed. Other computers are signed out.');
    } catch (e) { err.textContent = e.message; }
  });
}

// The button shows who is signed in: changes are logged under this username.
function showAccountName() {
  const b = document.getElementById('acctbtn');
  if (b) b.textContent = ls.get('acctuser') || 'Account';
}
(function addAccountButton() {
  const sync = document.getElementById('sync');
  if (!sync || document.getElementById('acctbtn')) return;
  const b = document.createElement('button');
  b.id = 'acctbtn'; b.type = 'button'; b.title = 'Signed in. Click to change the password or sign out';
  b.addEventListener('click', openAccount);
  sync.parentNode.appendChild(b);
  showAccountName();
})();
