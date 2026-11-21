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
        <label>Password<input name="password" type="password" autocomplete="${make ? 'new-password' : 'current-password'}" ${make ? 'minlength="8"' : ''} required></label>
        ${make ? '<label>Password again<input name="password2" type="password" autocomplete="new-password" required></label><p class="hint" style="margin:0">At least 8 characters.</p>' : ''}
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
        <label>New password (8+ characters)<input name="n1" type="password" autocomplete="new-password" minlength="8" required></label>
        <label>New password again<input name="n2" type="password" autocomplete="new-password" required></label>
        <div class="err" id="pwerr" style="min-height:18px"></div>
        <button class="primary" type="submit">Change password</button>
        <p class="hint" style="margin:6px 0 0">Every other computer is signed out and must sign in again.</p>
      </form></details>
    <details style="margin-top:8px"><summary><b>Scryfall extension key</b></summary>
      <p class="hint" style="margin:6px 0">Type this key once into the Scryfall extension's popup (Advanced) on each computer. It lets the extension add cards, and nothing else.</p>
      <div class="row" style="gap:6px"><input id="xkey" type="text" readonly placeholder="Press Show key" style="flex:1"><button id="xshow">Show key</button><button id="xcopy">Copy</button></div>
      <button id="xnew" style="margin-top:6px">Make a new key</button>
      <div class="hint" id="xmsg" style="min-height:16px"></div>
    </details>
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
  $m('#xshow').onclick = async () => { try { $m('#xkey').value = (await api('extKey')).key; $m('#xmsg').textContent = ''; } catch (e) { $m('#xmsg').textContent = e.message; } };
  $m('#xcopy').onclick = async () => {
    try { if (!$m('#xkey').value) $m('#xkey').value = (await api('extKey')).key; await navigator.clipboard.writeText($m('#xkey').value); $m('#xmsg').textContent = 'Copied'; }
    catch (e) { $m('#xmsg').textContent = 'Could not copy. Select the key and copy it.'; }
  };
  $m('#xnew').onclick = async () => {
    if (!confirm('Make a new extension key? The extension on every computer stops working until you type the new key into it.')) return;
    try { $m('#xkey').value = (await api('newExtKey')).key; $m('#xmsg').textContent = 'New key made. Update the extension on each computer.'; } catch (e) { $m('#xmsg').textContent = e.message; }
  };
}

(function addAccountButton() {
  const who = document.getElementById('who');
  if (!who || document.getElementById('acctbtn')) return;
  const b = document.createElement('button');
  b.id = 'acctbtn'; b.type = 'button'; b.textContent = 'Account'; b.title = 'Change password, extension key, sign out';
  b.addEventListener('click', openAccount);
  who.parentNode.insertBefore(b, who);
})();
