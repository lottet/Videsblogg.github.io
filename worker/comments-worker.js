/*
 * Vides Blogg — comments Worker
 *
 * Not deployed automatically — paste this into a Cloudflare Worker (see
 * README-worker.md for the exact setup steps). It's kept here only for
 * version control / reference.
 *
 * What it does: accepts a comment submission, verifies the site password
 * server-side, then encrypts the comment and appends it to comments.json
 * in the repo via the GitHub Contents API. The GitHub token never reaches
 * the browser — it lives only as a Worker secret.
 *
 * Verification uses posts.json's separate `commentAuth` field (its own
 * salt + check value), not the main `salt`/`check` used for post content.
 * Cloudflare Workers cap PBKDF2 at 100,000 iterations, while the main site
 * uses 150,000 (fine in real browsers) — reusing the main check here would
 * either fail outright or derive a different key than posts were encrypted
 * with. commentAuth is created by admin/index.html the first time it's
 * unlocked after this feature was added, at a Worker-compatible iteration
 * count, without touching the existing post encryption at all.
 */

const GITHUB_OWNER = 'lottet';
const GITHUB_REPO = 'Videsblogg.github.io';
const GITHUB_BRANCH = 'main';
const ALLOWED_ORIGIN = 'https://www.videsblogg.se';

const PBKDF2_ITERATIONS = 100000;
const CHECK_PLAINTEXT = 'lov-och-black-ok';
const MAX_NAME_LEN = 100;
const MAX_TEXT_LEN = 2000;

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function jsonResponse(obj, status){
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders())
  });
}

function b64ToBuf(b64){
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}
function bufToB64(buf){
  let bin = '';
  const bytes = new Uint8Array(buf);
  for(let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
async function deriveKey(password, saltB64){
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt:b64ToBuf(saltB64), iterations:PBKDF2_ITERATIONS, hash:'SHA-256' },
    baseKey,
    { name:'AES-GCM', length:256 },
    false,
    ['encrypt','decrypt']
  );
}
async function encryptText(key, plaintext){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv:iv}, key, new TextEncoder().encode(plaintext));
  return { iv:bufToB64(iv), ct:bufToB64(ct) };
}
async function decryptText(key, field){
  const pt = await crypto.subtle.decrypt(
    { name:'AES-GCM', iv:b64ToBuf(field.iv) },
    key,
    b64ToBuf(field.ct)
  );
  return new TextDecoder().decode(pt);
}

function b64EncodeUnicode(str){
  return btoa(unescape(encodeURIComponent(str)));
}
function b64DecodeUnicode(str){
  return decodeURIComponent(escape(atob(str)));
}

async function githubGetJson(path, token){
  const url = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + path + '?ref=' + GITHUB_BRANCH;
  const res = await fetch(url, {
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'vides-blogg-comments-worker'
    }
  });
  if(res.status === 404) return { data:null, sha:null };
  if(!res.ok) throw new Error('Kunde inte läsa ' + path + ' (' + res.status + ')');
  const json = await res.json();
  const content = b64DecodeUnicode(json.content.replace(/\n/g, ''));
  return { data: content.trim() ? JSON.parse(content) : null, sha: json.sha };
}

async function githubPutJson(path, dataObj, sha, message, token){
  const url = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + path;
  const body = {
    message: message,
    content: b64EncodeUnicode(JSON.stringify(dataObj, null, 2)),
    branch: GITHUB_BRANCH
  };
  if(sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'vides-blogg-comments-worker'
    },
    body: JSON.stringify(body)
  });
  if(!res.ok){
    const err = await res.json().catch(function(){ return {}; });
    throw new Error(err.message || ('Kunde inte spara ' + path + ' (' + res.status + ')'));
  }
}

export default {
  async fetch(request, env){
    if(request.method === 'OPTIONS'){
      return new Response(null, { headers: corsHeaders() });
    }
    if(request.method !== 'POST'){
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    let body;
    try{
      body = await request.json();
    } catch(err){
      return jsonResponse({ error: 'Ogiltig förfrågan.' }, 400);
    }

    const postId = String(body.postId || '').trim();
    const password = String(body.password || '');
    const name = String(body.name || '').trim().slice(0, MAX_NAME_LEN);
    const text = String(body.text || '').trim().slice(0, MAX_TEXT_LEN);

    if(!postId || !password || !name || !text){
      return jsonResponse({ error: 'Fyll i namn och kommentar.' }, 400);
    }

    const token = env.GITHUB_TOKEN;

    try{
      const { data: posts } = await githubGetJson('posts.json', token);
      if(!posts || !posts.commentAuth){
        return jsonResponse({ error: 'Kommentarer är inte aktiverade än. Logga in på adminsidan en gång för att aktivera dem.' }, 400);
      }

      const key = await deriveKey(password, posts.commentAuth.salt);
      let check;
      try{
        check = await decryptText(key, posts.commentAuth.check);
      } catch(err){
        return jsonResponse({ error: 'Fel lösenord.' }, 401);
      }
      if(check !== CHECK_PLAINTEXT){
        return jsonResponse({ error: 'Fel lösenord.' }, 401);
      }

      const { data: existing, sha } = await githubGetJson('comments.json', token);
      const comments = Array.isArray(existing) ? existing : [];

      comments.push({
        id: 'c_' + Date.now(),
        postId: postId,
        date: new Date().toISOString(),
        name: await encryptText(key, name),
        text: await encryptText(key, text)
      });

      await githubPutJson('comments.json', comments, sha, 'Ny kommentar', token);

      return jsonResponse({ ok:true });
    } catch(err){
      return jsonResponse({ error: err.message || 'Något gick fel.' }, 500);
    }
  }
};
