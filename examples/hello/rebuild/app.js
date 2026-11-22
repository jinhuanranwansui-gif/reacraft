// A deliberately incomplete rebuild of examples/hello/target.txt.
//
// It has the session endpoint and the licence wording, but not the CDN asset, the registry
// key or the config path. Running verify on it produces a partial score and a gap plan that
// names exactly the three missing literals — that is the behaviour the example demonstrates.
'use strict';

const SESSION_URL = 'https://api.example.test/v1/session';
const LICENCE = 'Activation Code';

async function openSession(token) {
  const res = await fetch(SESSION_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(LICENCE + ' rejected: ' + res.status);
  return res.json();
}

module.exports = { openSession, SESSION_URL, LICENCE };
