// 毕业论文小助手 - Cloudflare Worker
// 功能：1) 访问计数（PV/UV，KV 存储） 2) 建议栏（毕业生建议收集，KV 存储）
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

    // ===== 建议弹幕（公开提交/可见 + 敏感词拦截 + 管理删除） =====
    const ADMIN_PWD = 'xz123';
    const BAD_WORDS = ['操你妈','你妈的','他妈的','草泥马','傻逼','傻b','煞笔','傻屌','cnm','wqnmlgb','nmsl','妈的','滚蛋','去死','贱人','妓女','嫖','卖淫','约炮','做爱','色情','裸聊','赌博','博彩','代写论文','代发论文','假学历','办证','毒品','冰毒','海洛因','枪支','弹药','恐怖','暴恐','反动','法轮','台独','藏独','港独','疆独'];
    const hasBad = (s) => BAD_WORDS.some(w => s.toLowerCase().includes(w));

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
        const list = JSON.parse((await env.KV.get('suggestions')) || '[]');
        if (list.length >= 500) list.splice(0, list.length - 499); // 上限500条，超出删最旧
        const nid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        list.push({ id: nid, t: Date.now(), name, text, likes: 0 });
        await env.KV.put('suggestions', JSON.stringify(list));
        return json({ ok: true, id: nid });
      }
      if (request.method === 'GET') {
        const list = JSON.parse((await env.KV.get('suggestions')) || '[]');
        return json(list.slice(-100).map(x => ({ id: x.id, t: x.t, name: x.name || '', text: x.text, likes: x.likes || 0 })).reverse()); // 公开仅返回最近100条
      }
    }
    // 点赞接口
    if (url.pathname === '/suggest/like' && request.method === 'POST') {
      try {
        const j = await request.json();
        let list = JSON.parse((await env.KV.get('suggestions')) || '[]');
        const it = list.find(x => String(x.id) === String(j.id));
        if (!it) return json({ ok: false, msg: '未找到该条' });
        it.likes = (it.likes || 0) + 1;
        await env.KV.put('suggestions', JSON.stringify(list));
        return json({ ok: true, likes: it.likes });
      } catch (e) { return json({ ok: false }); }
    }
    // 管理接口：删除单条 / 清空（需站密码）
    if (url.pathname === '/suggest/delete' && request.method === 'POST') {
      try {
        const j = await request.json();
        if (j.pwd !== ADMIN_PWD) return json({ ok: false, msg: '密码错误' });
        let list = JSON.parse((await env.KV.get('suggestions')) || '[]');
        list = list.filter(x => String(x.id) !== String(j.id));
        await env.KV.put('suggestions', JSON.stringify(list));
        return json({ ok: true });
      } catch (e) { return json({ ok: false }); }
    }
    if (url.pathname === '/suggest/clear' && request.method === 'POST') {
      try {
        const j = await request.json();
        if (j.pwd !== ADMIN_PWD) return json({ ok: false, msg: '密码错误' });
        await env.KV.put('suggestions', '[]');
        return json({ ok: true });
      } catch (e) { return json({ ok: false }); }
    }

    // ===== 随机歌曲（CC 授权曲库，KV 存中英文现代歌曲） =====
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

    // ===== 天气（按访问者 IP 定位，Open-Meteo 免费天气） =====
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

    // ===== 访问计数 =====
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
