// OZKIZ Shoes 작업지시서 — 노션 → 사이트 데이터 변환
// Vercel Serverless Function
//
// 캐싱 전략 (3중):
//  1) 인메모리 캐시 — Lambda warm 상태 동안 즉시 응답
//  2) Vercel Edge CDN — Cache-Control 헤더로 5분 fresh, 55분 stale
//  3) 클라이언트 localStorage — 1시간 (HTML 측에서 처리)

const NOTION_VERSION = '2025-09-03';
const PRODUCT_DS_ID = '09981565-42db-4946-a747-13ea92c3d772';
const ORDER_DS_ID   = '5d13f212-7945-4177-ba16-7b0f8a47bc56';

// 작업지시서에 보일 제품 범위 — 여기 년도만 수정하면 됨
const TARGET_YEARS = ['2025', '2026', '2027'];

// 인메모리 캐시 (모듈 레벨 — 같은 Lambda 인스턴스에서 공유)
const CACHE_TTL_FRESH = 5  * 60 * 1000;  //  5분: 즉시 반환
const CACHE_TTL_STALE = 60 * 60 * 1000;  // 60분: stale-while-revalidate
let cache = { data: null, timestamp: 0, refreshing: false };

module.exports = async function handler(req, res) {
  try {
    const token = process.env.NOTION_TOKEN;
    if (!token) {
      return res.status(500).json({
        error: 'NOTION_TOKEN 환경변수가 설정되지 않았습니다. Vercel 대시보드에서 등록해주세요.'
      });
    }

    const now = Date.now();
    const age = now - cache.timestamp;

    // 1) Fresh 캐시 — 5분 이내라면 노션 호출 없이 즉시 응답
    if (cache.data && age < CACHE_TTL_FRESH) {
      return sendCached(res, cache.data, 'HIT-FRESH', age);
    }

    // 2) Stale 캐시 — 1시간 이내라면 즉시 stale 응답 + 백그라운드에서 갱신
    if (cache.data && age < CACHE_TTL_STALE) {
      sendCached(res, cache.data, 'HIT-STALE', age);
      // 중복 백그라운드 갱신 방지
      if (!cache.refreshing) {
        cache.refreshing = true;
        fetchAndMap(token)
          .then(fresh => { cache = { data: fresh, timestamp: Date.now(), refreshing: false }; })
          .catch(err => { cache.refreshing = false; console.error('Background refresh failed:', err); });
      }
      return;
    }

    // 3) 캐시 없거나 1시간 초과 — 신선하게 가져와서 응답
    const data = await fetchAndMap(token);
    cache = { data, timestamp: Date.now(), refreshing: false };
    return sendCached(res, data, 'MISS', 0);

  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
};

function sendCached(res, data, status, ageMs) {
  // Vercel Edge CDN 캐시: 5분 fresh + 55분 stale-while-revalidate
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3300');
  res.setHeader('X-Cache', status);
  res.setHeader('X-Cache-Age-Sec', String(Math.round(ageMs / 1000)));
  res.status(200).json(data);
}

// ─────────────────────────── 노션 fetch + 매핑 ───────────────────────────

async function fetchAndMap(token) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  };

  // 슈즈 + 최근 N년 제품만 조회
  const products = await queryAll(PRODUCT_DS_ID, headers, {
    filter: {
      and: [
        { property: '의류/슈즈/잡화', select: { equals: '슈즈' } },
        { or: TARGET_YEARS.map(y => ({ property: '개발년도', select: { equals: y } })) }
      ]
    }
  });

  // 슈즈 제품 ID로 발주만 필터링 — 청크 병렬 호출
  const productIds = products.map(p => p.id);
  const CHUNK = 50;
  const chunks = [];
  for (let i = 0; i < productIds.length; i += CHUNK) {
    chunks.push(productIds.slice(i, i + CHUNK));
  }
  const chunkResults = await Promise.all(chunks.map(chunk => {
    const filter = chunk.length === 1
      ? { property: '관계형 title', relation: { contains: chunk[0] } }
      : { or: chunk.map(id => ({ property: '관계형 title', relation: { contains: id } })) };
    return queryAll(ORDER_DS_ID, headers, { filter });
  }));
  const orders = chunkResults.flat();

  // 제품별로 발주 그룹화
  const ordersByProduct = {};
  for (const o of orders) {
    const rels = (o.properties['관계형 title']?.relation) || [];
    for (const r of rels) {
      if (!ordersByProduct[r.id]) ordersByProduct[r.id] = [];
      ordersByProduct[r.id].push(o);
    }
  }

  return products.map((p, i) =>
    mapProduct(p, ordersByProduct[p.id] || [], i + 1)
  );
}

async function queryAll(dsId, headers, body) {
  const all = [];
  let cursor;
  do {
    const reqBody = { ...body, page_size: 100 };
    if (cursor) reqBody.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/data_sources/${dsId}/query`, {
      method: 'POST', headers, body: JSON.stringify(reqBody)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Notion query failed: ${data.message || JSON.stringify(data)}`);
    all.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return all;
}

// ─────────────────────────── 헬퍼 ───────────────────────────

function getText(prop) {
  if (!prop) return '';
  if (prop.type === 'title')     return (prop.title     || []).map(t => t.plain_text).join('');
  if (prop.type === 'rich_text') return (prop.rich_text || []).map(t => t.plain_text).join('');
  return '';
}

function getImg(prop) {
  const f = prop?.files?.[0];
  if (!f) return null;
  if (f.type === 'file')     return f.file.url;        // 노션 호스팅 (1시간 만료)
  if (f.type === 'external') return f.external.url;    // 외부 URL
  return null;
}

function simplifyStatus(s) {
  if (!s) return '대기';
  if (s.includes('계속판매')) return '계속판매';
  if (s.includes('생산중'))   return '생산중';
  if (s.includes('생산 요청') || s.includes('생산요청')) return '생산요청';
  if (s.includes('단종') || s.includes('완료')) return '완료';
  if (s.includes('취소')) return '진행취소';
  return '대기';
}

function parseLines(text) {
  if (!text) return [];
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}

function mapProduct(page, myOrders, idx) {
  const p = page.properties;

  // 발주 매트릭스 — "f.색상/사이즈" rich_text를 ":색상, :사이즈" 형식으로 파싱
  const ord = myOrders.map(o => {
    const cs = getText(o.properties['f.색상/사이즈']);
    const parts = cs.split(',').map(s => s.trim().replace(/^:/, '').trim());
    return {
      c:  parts[0] || '',
      s:  parts[1] || '',
      q:  o.properties['g.발주수량']?.number || 0,
      od: o.properties['a.발주일']?.date?.start || '',
      dd: o.properties['b.입고일(예정)']?.date?.start || '',
      r:  o.properties['k.발주차수']?.select?.name || '1차'
    };
  }).filter(r => r.c && r.s);

  const remText = getText(p['생산지시 특이사항']);
  const rem = parseLines(remText);

  const histText = getText(p['히스토리']);
  const hist = histText
    ? histText.split('\n').map(line => {
        const parts = line.split('|').map(s => s.trim());
        if (parts.length < 2) return null;
        return { d: parts[0], t: parts[1], b: parts[2] || '' };
      }).filter(Boolean)
    : [];

  return {
    id:       idx,
    notionId: page.id,
    name:    getText(p['제품명']) || '(이름 없음)',
    style:   getText(p['품번']) || `OZK-${String(idx).padStart(4, '0')}`,
    brand:   p['브랜드']?.select?.name || '오즈키즈',
    vendor:  p['생산공장']?.select?.name || '-',
    region:  p['원산지']?.select?.name || '-',
    year:    parseInt(p['개발년도']?.select?.name) || new Date().getFullYear(),
    cat:     p['복종']?.select?.name || '-',
    season:  p['시즌']?.multi_select?.[0]?.name || '-',
    status:  simplifyStatus(p['진행상태']?.status?.name),
    last:    getText(p['라스트']) || '-',
    type:    p['제품유형']?.multi_select?.[0]?.name || '-',
    gender:  p['성별']?.select?.name || null,
    moq:     p['MOQ']?.number || null,
    img:     getImg(p['대표이미지']),

    uv: 0, us: 0, ue: 0, ur: 0,
    uc:      p['원가']?.number || 0,
    rt:      p['판매가']?.number || 0,
    ed:      p['입고일']?.date?.start || '',

    fabric:    getText(p['원단명']) || '',
    supplies:  parseLines(getText(p['부자재 구매'])),
    kcStatus:  p['KC진행']?.select?.name || '',
    kcFiles:   (p['KC 시험성적서']?.files || []).map(f => ({
      name: f.name || 'KC 서류',
      url:  f.type === 'file' ? f.file?.url : (f.external?.url || null)
    })).filter(f => f.url),

    rem, ord, hist
  };
}
