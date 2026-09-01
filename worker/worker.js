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

    // ===== 建议栏 =====
    if (url.pathname === '/suggest') {
      if (request.method === 'POST') {
        let text = '';
        try { text = (await request.text()).slice(0, 2000); } catch (e) {}
        if (text && text.trim()) {
          const list = JSON.parse((await env.KV.get('suggestions')) || '[]');
          list.push({ t: Date.now(), text: text.trim() });
          await env.KV.put('suggestions', JSON.stringify(list));
          return json({ ok: true });
        }
        return json({ ok: false, msg: '内容为空' });
      }
      if (request.method === 'GET') {
        // 查看建议（管理员用，可在 URL 加 ?key=xxx 简单保护，这里直接返回）
        const list = JSON.parse((await env.KV.get('suggestions')) || '[]');
        return json(list);
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
