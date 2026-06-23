// 노션 이미지(S3)를 우리 도메인으로 프록시 — CORS 우회용
// html2canvas로 모달 캡처 시 외부 이미지가 막히는 문제 해결
//
// 사용: /api/img-proxy?url=<encoded notion S3 URL>

const ALLOWED_HOSTS = [
  'prod-files-secure.s3.us-west-2.amazonaws.com',
  's3.us-west-2.amazonaws.com',
  'file.notion.so',
  'www.notion.so',
  'images.unsplash.com'   // 혹시 다른 이미지 호스트 쓸 때 대비
];

module.exports = async function handler(req, res) {
  try {
    const url = req.query?.url;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url query 필요' });
    }

    // 보안: 허용된 도메인만
    let parsed;
    try { parsed = new URL(url); } catch (e) {
      return res.status(400).json({ error: 'invalid url' });
    }
    if (!ALLOWED_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
      return res.status(403).json({ error: '허용되지 않은 도메인: ' + parsed.hostname });
    }

    // 노션 이미지 fetch
    const r = await fetch(url);
    if (!r.ok) {
      return res.status(r.status).json({ error: 'fetch 실패: ' + r.status });
    }

    const contentType = r.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await r.arrayBuffer());

    // CORS 허용 + 10분 캐시
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(buffer);
  } catch (err) {
    console.error('img-proxy error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
};
