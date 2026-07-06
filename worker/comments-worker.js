/*
 * Vides Blogg — comments + admin Worker
 *
 * Not deployed automatically — paste this into a Cloudflare Worker (see
 * README-worker.md for the exact setup steps). It's kept here only for
 * version control / reference.
 *
 * Two jobs, both proxying the GitHub Contents API with a token that only
 * ever lives as a Worker secret:
 *
 * 1. POST / (or /comment) — a reader submits a comment. Verified against
 *    posts.json's separate `commentAuth` field (its own salt + check
 *    value), not the main `salt`/`check` used for post content. Cloudflare
 *    Workers cap PBKDF2 at 100,000 iterations, while the main site uses
 *    150,000 (fine in real browsers) — reusing the main check here would
 *    either fail outright or derive a different key than posts were
 *    encrypted with. commentAuth is created by admin/index.html the first
 *    time it's unlocked after this feature was added.
 *
 * 2. POST /admin/posts, /admin/save, /admin/upload-image, /admin/delete-post
 *    — the admin panel logs in with a username/password checked against
 *    this Worker's own ADMIN_USERNAME/ADMIN_PASSWORD secrets, then every
 *    publish/delete/image-upload/tagline-save goes through here instead
 *    of the browser calling GitHub directly. admin/index.html never holds
 *    a GitHub token. /admin/delete-post cascades: removes the post,
 *    drops any comments referencing it, and deletes its image files —
 *    instead of just unlinking the post and leaving orphans behind.
 *
 * 3. GET /posts, GET /comments — index.html reads posts.json/comments.json
 *    through here instead of fetching the static files GitHub Pages
 *    serves. The Contents API always reflects the latest commit
 *    immediately; Pages' build-and-deploy step (which is what the static
 *    fetch depends on) can lag behind by anywhere from seconds to a
 *    couple of minutes. No auth needed — same trust model as the static
 *    files: publicly fetchable, private only because the content itself
 *    is encrypted.
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
  const json = await res.json();
  return json.content.sha;
}

async function githubPutFile(path, base64Content, message, token){
  const url = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + path;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'vides-blogg-comments-worker'
    },
    body: JSON.stringify({ message:message, content:base64Content, branch:GITHUB_BRANCH })
  });
  if(!res.ok){
    const err = await res.json().catch(function(){ return {}; });
    throw new Error(err.message || ('Kunde inte ladda upp bild (' + res.status + ')'));
  }
}

async function githubDeleteFile(path, message, token){
  const url = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + path;
  const getRes = await fetch(url + '?ref=' + GITHUB_BRANCH, {
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'vides-blogg-comments-worker'
    }
  });
  if(getRes.status === 404) return;
  if(!getRes.ok) throw new Error('Kunde inte hitta ' + path + ' (' + getRes.status + ')');
  const info = await getRes.json();
  const delRes = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'vides-blogg-comments-worker'
    },
    body: JSON.stringify({ message:message, sha:info.sha, branch:GITHUB_BRANCH })
  });
  if(!delRes.ok){
    const err = await delRes.json().catch(function(){ return {}; });
    throw new Error(err.message || ('Kunde inte ta bort ' + path + ' (' + delRes.status + ')'));
  }
}

/* ---------- Comment submission ---------- */
async function handleComment(request, env){
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

/* ---------- Admin auth ---------- */
function safeCompare(a, b){
  if(typeof a !== 'string' || typeof b !== 'string') return false;
  if(a.length !== b.length) return false;
  let result = 0;
  for(let i = 0; i < a.length; i++){
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function checkAdminAuth(body, env){
  return safeCompare(String(body.username || ''), env.ADMIN_USERNAME || '') &&
    safeCompare(String(body.password || ''), env.ADMIN_PASSWORD || '');
}

async function handleAdminGetPosts(request, env){
  let body;
  try{ body = await request.json(); } catch(err){ return jsonResponse({ error:'Ogiltig förfrågan.' }, 400); }
  if(!checkAdminAuth(body, env)) return jsonResponse({ error:'Fel användarnamn eller lösenord.' }, 401);

  const token = env.GITHUB_TOKEN;
  try{
    const { data, sha } = await githubGetJson('posts.json', token);
    return jsonResponse({ data:data, sha:sha });
  } catch(err){
    return jsonResponse({ error: err.message || 'Något gick fel.' }, 500);
  }
}

async function handleAdminSave(request, env){
  let body;
  try{ body = await request.json(); } catch(err){ return jsonResponse({ error:'Ogiltig förfrågan.' }, 400); }
  if(!checkAdminAuth(body, env)) return jsonResponse({ error:'Fel användarnamn eller lösenord.' }, 401);
  if(!body.data || typeof body.data !== 'object') return jsonResponse({ error:'Ogiltig data.' }, 400);

  const token = env.GITHUB_TOKEN;
  try{
    const sha = await githubPutJson('posts.json', body.data, body.sha || null, body.message || 'Uppdatera inlägg', token);
    return jsonResponse({ sha:sha });
  } catch(err){
    return jsonResponse({ error: err.message || 'Något gick fel.' }, 500);
  }
}

/* Deleting a post used to just drop it from posts.json, leaving its
   comments (orphaned by postId) and uploaded images stranded in the repo
   forever. This does all three in one call: remove the post, drop any
   comments referencing it, delete its image files. */
async function handleAdminDeletePost(request, env){
  let body;
  try{ body = await request.json(); } catch(err){ return jsonResponse({ error:'Ogiltig förfrågan.' }, 400); }
  if(!checkAdminAuth(body, env)) return jsonResponse({ error:'Fel användarnamn eller lösenord.' }, 401);

  const postId = String(body.postId || '').trim();
  if(!postId) return jsonResponse({ error:'Inlägg saknas.' }, 400);
  const imagePaths = Array.isArray(body.imagePaths) ? body.imagePaths : [];

  const token = env.GITHUB_TOKEN;
  try{
    const { data: posts, sha: postsSha } = await githubGetJson('posts.json', token);
    if(!posts) return jsonResponse({ error:'Hittade inte posts.json.' }, 404);
    const nextPosts = Object.assign({}, posts, {
      posts: posts.posts.filter(function(p){ return p.id !== postId; })
    });
    const newSha = await githubPutJson('posts.json', nextPosts, postsSha, 'Ta bort inlägg: ' + postId, token);

    const { data: comments, sha: commentsSha } = await githubGetJson('comments.json', token);
    if(Array.isArray(comments)){
      const remaining = comments.filter(function(c){ return c.postId !== postId; });
      if(remaining.length !== comments.length){
        await githubPutJson('comments.json', remaining, commentsSha, 'Ta bort kommentarer för borttaget inlägg', token);
      }
    }

    for(const path of imagePaths){
      await githubDeleteFile(path, 'Ta bort bild: ' + path, token);
    }

    return jsonResponse({ sha:newSha });
  } catch(err){
    return jsonResponse({ error: err.message || 'Något gick fel.' }, 500);
  }
}

async function handleAdminUploadImage(request, env){
  let body;
  try{ body = await request.json(); } catch(err){ return jsonResponse({ error:'Ogiltig förfrågan.' }, 400); }
  if(!checkAdminAuth(body, env)) return jsonResponse({ error:'Fel användarnamn eller lösenord.' }, 401);

  const path = String(body.path || '').trim();
  const content = String(body.content || '');
  if(!path || !content) return jsonResponse({ error:'Bild eller sökväg saknas.' }, 400);

  const token = env.GITHUB_TOKEN;
  try{
    await githubPutFile(path, content, 'Ladda upp bild: ' + path, token);
    return jsonResponse({ ok:true });
  } catch(err){
    return jsonResponse({ error: err.message || 'Något gick fel.' }, 500);
  }
}

/* ---------- Public reads (bypass GitHub Pages' build lag) ---------- */
async function handlePublicGetPosts(env){
  try{
    const { data } = await githubGetJson('posts.json', env.GITHUB_TOKEN);
    return jsonResponse(data);
  } catch(err){
    return jsonResponse({ error: err.message || 'Något gick fel.' }, 500);
  }
}

async function handlePublicGetComments(env){
  try{
    const { data } = await githubGetJson('comments.json', env.GITHUB_TOKEN);
    return jsonResponse(Array.isArray(data) ? data : []);
  } catch(err){
    return jsonResponse({ error: err.message || 'Något gick fel.' }, 500);
  }
}

export default {
  async fetch(request, env){
    if(request.method === 'OPTIONS'){
      return new Response(null, { headers: corsHeaders() });
    }

    const path = new URL(request.url).pathname;

    if(request.method === 'GET'){
      if(path === '/posts') return handlePublicGetPosts(env);
      if(path === '/comments') return handlePublicGetComments(env);
      return jsonResponse({ error: 'Not found' }, 404);
    }

    if(request.method !== 'POST'){
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    if(path === '/admin/posts') return handleAdminGetPosts(request, env);
    if(path === '/admin/save') return handleAdminSave(request, env);
    if(path === '/admin/upload-image') return handleAdminUploadImage(request, env);
    if(path === '/admin/delete-post') return handleAdminDeletePost(request, env);
    return handleComment(request, env);
  }
};
