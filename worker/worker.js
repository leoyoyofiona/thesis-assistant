// 毕业论文小助手 - Cloudflare Worker
// 功能：1) 建议栏（先审后发：新留言进入待审队列，管理员通过后公开显示；KV 存储）
//      2) 管理鉴权（口令仅以 SHA-256 哈希存于 KV/环境变量，绝不写入前端或源码）
//      3) 随机歌曲（CC/免版税曲库，KV）  4) 天气 5) 访问计数（PV/UV，KV）
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    const json = (obj, extra = {}) =>
      new Response(JSON.stringify(obj), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors, ...extra },
      });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // 口令安全：页面与前端源码绝不出现明文口令；仅存哈希于 KV/环境变量
    const sha256 = async (s) => {
      try {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s || '')));
        return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
      } catch (e) { return ''; }
    };
    const kvHash = async (key) => { try { return (await env.KV.get(key)) || ''; } catch (e) { return ''; } };
    // 管理员口令哈希（优先 KV，兼容环境变量）
    const adminHash = async () => ((await kvHash('admin_pwd_hash')) || ((env && env.ADMIN_PWD_HASH) || ''));
    const isAdmin = async (pwd) => { const h = await sha256(pwd); return !!h && h === await adminHash(); };
    const BAD_WORDS = ['操你妈','你妈的','他妈的','草泥马','傻逼','傻b','煞笔','傻屌','傻叉','cnm','wqnmlgb','nmsl','妈的','滚蛋','去死','贱人','妓女','嫖','卖淫','约炮','做爱','色情','裸聊','赌博','博彩','代写论文','代发论文','假学历','办证','毒品','冰毒','海洛因','枪支','弹药','恐怖','暴恐','反动','法轮','台独','藏独','港独','疆独'];
    const hasBad = (s) => BAD_WORDS.some(w => s.toLowerCase().includes(w));

    const readList = async () => JSON.parse((await env.KV.get('suggestions')) || '[]');
    const saveList = (list) => env.KV.put('suggestions', JSON.stringify(list));
    // 旧数据无 status 字段 → 视为已公开(approved)，保持兼容
    const isPublic = (x) => x.status !== 'pending';

    // ===== 建议（公开读取仅返回已审核内容；新留言进入待审） =====
    if (url.pathname === '/suggest') {
      if (request.method === 'POST') {
        let raw = '';
        try { raw = (await request.text()).slice(0, 1500); } catch (e) {}
        let name = '', text = raw;
        try { const j = JSON.parse(raw); if (j && typeof j === 'object') { text = String(j.text || ''); name = String(j.name || ''); } } catch (e) {}
        text = (text || '').trim(); name = (name || '').trim();
        if (!text) return json({ ok: false, msg: '内容不能为空' });
        if (text.length > 1000) return json({ ok: false, msg: '内容过长（最多1000字）' });
        if (name.length > 20) return json({ ok: false, msg: '昵称过长（最多20字）' });
        if (hasBad(text) || hasBad(name)) return json({ ok: false, msg: '内容包含不当词汇，请修改后重试' });
        const list = await readList();
        if (list.length >= 500) list.splice(0, list.length - 499); // 上限500条，超出删最旧
        const nid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        list.push({ id: nid, t: Date.now(), name, text, likes: 0, status: 'pending' });
        await saveList(list);
        return json({ ok: true, id: nid, pending: true });
      }
      if (request.method === 'GET') {
        const list = await readList();
        // 仅公开已审核内容；同人同内容只保留一条，点赞数合并
        const seen = {};
        const out = [];
        for (const x of list) {
          if (!isPublic(x)) continue;
          const k = String(x.name || '') + '|' + String(x.text || '');
          if (seen[k] != null) { out[seen[k]].likes = (out[seen[k]].likes || 0) + (x.likes || 0); continue; }
          seen[k] = out.length;
          out.push({ id: x.id, t: x.t, name: x.name || '', text: x.text, likes: x.likes || 0, reply: x.reply || '', replyTime: x.replyTime || 0 });
        }
        return json(out.slice(-100).reverse());
      }
    }

    // 管理端读取全部（含待审核）
    if (url.pathname === '/suggest/admin-list' && request.method === 'POST') {
      try {
        const j = await request.json();
        if (!(await isAdmin(j.pwd))) return json({ ok: false, msg: '权限不足' });
        const list = await readList();
        return json({ ok: true, list: list.slice(-200).reverse() });
      } catch (e) { return json({ ok: false }); }
    }

    // 管理端审核通过一条留言
    if (url.pathname === '/suggest/approve' && request.method === 'POST') {
      try {
        const j = await request.json();
        if (!(await isAdmin(j.pwd))) return json({ ok: false, msg: '权限不足' });
        let list = await readList();
        const it = list.find(x => String(x.id) === String(j.id));
        if (!it) return json({ ok: false, msg: '未找到该条' });
        it.status = 'approved';
        await saveList(list);
        return json({ ok: true });
      } catch (e) { return json({ ok: false }); }
    }

    // 点赞（仅允许对已审核公开内容；按访问者IP指纹去重）
    if (url.pathname === '/suggest/like' && request.method === 'POST') {
      try {
        const j = await request.json();
        const list = await readList();
        const it = list.find(x => String(x.id) === String(j.id));
        if (!it) return json({ ok: false, msg: '未找到该条' });
        if (!isPublic(it)) return json({ ok: false, msg: '该留言尚未公开' });
        const ip = (request.headers.get('cf-connecting-ip') || '').trim();
        const ua = (request.headers.get('user-agent') || 'ua').slice(0, 60);
        const fp = ip + '|' + ua;
        const likers = it.likers || [];
        if (likers.includes(fp)) return json({ ok: true, already: true, likes: it.likes || 0 });
        likers.push(fp);
        if (likers.length > 300) likers.splice(0, likers.length - 300);
        it.likers = likers;
        it.likes = (it.likes || 0) + 1;
        await saveList(list);
        return json({ ok: true, already: false, likes: it.likes });
      } catch (e) { return json({ ok: false }); }
    }

    // 管理：删除单条 / 回复 / 清空（须服务端校验管理员口令）
    if (url.pathname === '/suggest/delete' && request.method === 'POST') {
      try {
        const j = await request.json();
        if (!(await isAdmin(j.pwd))) return json({ ok: false, msg: '权限不足' });
        let list = await readList();
        list = list.filter(x => String(x.id) !== String(j.id));
        await saveList(list);
        return json({ ok: true });
      } catch (e) { return json({ ok: false }); }
    }
    if (url.pathname === '/suggest/reply' && request.method === 'POST') {
      try {
        const j = await request.json();
        if (!(await isAdmin(j.pwd))) return json({ ok: false, msg: '权限不足' });
        const reply = String(j.reply || '').trim().slice(0, 300);
        let list = await readList();
        const it = list.find(x => String(x.id) === String(j.id));
        if (!it) return json({ ok: false, msg: '未找到该条' });
        it.reply = reply;
        it.replyTime = Date.now();
        if (!isPublic(it)) it.status = 'approved'; // 回复即视为通过审核并公开
        await saveList(list);
        return json({ ok: true });
      } catch (e) { return json({ ok: false }); }
    }
    if (url.pathname === '/suggest/clear' && request.method === 'POST') {
      try {
        const j = await request.json();
        if (!(await isAdmin(j.pwd))) return json({ ok: false, msg: '权限不足' });
        await env.KV.put('suggestions', '[]');
        return json({ ok: true });
      } catch (e) { return json({ ok: false }); }
    }

    // ===== 随机歌曲（CC/免版税曲库，KV 存） =====
    if (url.pathname === '/song') {
      try {
        const list = JSON.parse((await env.KV.get('songlist')) || '[]');
        if (list.length) {
          const s = list[Math.floor(Math.random() * list.length)];
          return json({ ok: true, url: s.url, title: s.title, artist: s.artist || '' });
        }
        return json({ ok: false });
      } catch (e) {
        return json({ ok: false });
      }
    }

    // ===== 天气（由 CF 边缘按访客 IP 定位，Open-Meteo 免费天气） =====
    if (url.pathname === '/weather') {
      try {
        const cf = request.cf || {};
        const lat = cf.latitude, lon = cf.longitude;
        let temp = null, code = null, wind = null;
        if (lat && lon) {
          const wr = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`,
            { headers: { 'User-Agent': 'thesis-assistant/1.0' }, signal: AbortSignal.timeout(6000) }
          );
          if (wr.ok) {
            const wd = await wr.json();
            const cw = wd.current_weather || {};
            if (typeof cw.temperature === 'number') temp = Math.round(cw.temperature);
            if (typeof cw.weathercode === 'number') code = cw.weathercode;
            if (typeof cw.windspeed === 'number') wind = Math.round(cw.windspeed);
          }
        }
        return json({ city: cf.city || '未知城市', temp, code, wind });
      } catch (e) {
        return json({ city: '未知城市', temp: null, code: null, wind: null });
      }
    }

    // ===== 访问计数（通用计数器，页面已改为静态展示，保留兼容） =====
    const pv = parseInt((await env.KV.get('pv')) || '0', 10) + 1;
    await env.KV.put('pv', String(pv));

    let uv = parseInt((await env.KV.get('uv')) || '0', 10);
    const hasVisited = (request.headers.get('Cookie') || '').includes('vis=1');
    let extra = {};
    if (!hasVisited) {
      uv += 1;
      await env.KV.put('uv', String(uv));
      extra = { 'Set-Cookie': 'vis=1; Max-Age=31536000; Path=/; SameSite=None; Secure' };
    }

    return json({ pv, uv }, extra);
  },
};
