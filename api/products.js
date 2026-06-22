// OZKIZ Shoes 작업지시서 — 노션 → 사이트 데이터 변환
// Vercel Serverless Function
//
// 최적화 전략:
//  ① Schema 인메모리 캐시 — 1일 (property name → id 매핑)
//  ② Properties Filtering — 필요한 컬럼만 노션에서 받음 (filter_properties)
//  ③ 병렬 호출 — schema fetch 병렬, 발주 청크 병렬 (Promise.all)
//  ④ 응답 압축 — 빈 배열/null/'-' 제거 (gzip은 Vercel 자동)
//  ⑤ 데이터 캐시 — 5분 fresh, 60분 stale-while-revalidate

const NOTION_VERSION = '2025-09-03';
const PRODUCT_DS_ID = '09981565-42db-4946-a747-13ea92c3d772';
const ORDER_DS_ID   = '5d13f212-7945-4177-ba16-7b0f8a47bc56';

const TARGET_YEARS = ['2025', '2026', '2027'];

// 진짜 화면에 표시되는 컬럼만 (제품 DB)
const PRODUCT_PROPS_NEEDED = [
  '제품명', '품번', '브랜드', '생산공장', '원산지', '개발년도',
  '복종', '시즌', '진행상태', '라스트', '제품유형', '성별', 'MOQ',
  '대표이미지', '원가', '판매가', '입고일',
  '의류/슈즈/잡화',
  '원단명', '부자재 구매', 'KC진행', 'KC 시험성적서',
  '생산지시 특이사항', '히스토리'
];

// 발주 DB에서 필요한 컬럼
const ORDER_PROPS_NEEDED = [
  '관계형 title',
  'a.발주일', 'b.입고일(예정)',
  'f.색상/사이즈', 'g.발주수량', 'k.발주차수'
];

// ───────────── 캐시 ─────────────

const CACHE_TTL_FRESH = 5  * 60 * 1000;        // 5분
const CACHE_TTL_STALE = 60 * 60 * 1000;        // 60분
const SCHEMA_TTL      = 24 * 60 * 60 * 1000;   // 1일

let dataCache   = { data: null, timestamp: 0, refreshing: false };
let schemaCache = { products: null, orders: null, timestamp: 0 };

// ───────────── 핸들러 ─────────────

module.exports = async function handler(req, res) {
  try {
    const token = process.env.NOTION_TOKEN;
    if (!token) {
      return res.status(500).json({ error: 'NOTION_TOKEN 환경변수가 설정되지 않았습니다.' });
    }

    // 강제 캐시 무효화 — /api/products?revalidate=1 호출 시
    const force = req.query?.revalidate === '1' || req.query?.refresh === '1';
    if (force) {
      dataCache = { data: null, timestamp: 0, refreshing: false };
      console.log('[revalidate] 인메모리 캐시 강제 무효화');
    }

    const now = Date.now();
    const age = now - dataCache.timestamp;

    // ① Fresh — 즉시 반환
    if (dataCache.data && age < CACHE_TTL_FRESH) {
      return sendCached(res, dataCache.data, 'HIT-FRESH', age);
    }

    // ② Stale — 즉시 stale 반환 + 백그라운드 갱신
    if (dataCache.data && age < CACHE_TTL_STALE) {
      sendCached(res, dataCache.data, 'HIT-STALE', age);
      if (!dataCache.refreshing) {
        dataCache.refreshing = true;
        fetchAndMap(token)
          .then(fresh => { dataCache = { data: fresh, timestamp: Date.now(), refreshing: false }; })
          .catch(err => { dataCache.refreshing = false; console.error('BG refresh failed:', err); });
      }
      return;
    }

    // ③ MISS — 신선하게
    const data = await fetchAndMap(token);
    dataCache = { data, timestamp: Date.now(), refreshing: false };
    return sendCached(res, data, 'MISS', 0);

  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
};

function sendCached(res, data, status, ageMs) {
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3300');
  res.setHeader('X-Cache', status);
  res.setHeader('X-Cache-Age-Sec', String(Math.round(ageMs / 1000)));
  res.status(200).json(data);
}

// ───────────── 노션 fetch ─────────────

async function fetchAndMap(token) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  };

  // 1) Schema 두 개 병렬 fetch (캐시되어 있으면 0초)
  const [productSchema, orderSchema] = await Promise.all([
    getSchemaCached('products', PRODUCT_DS_ID, headers),
    getSchemaCached('orders',   ORDER_DS_ID,   headers)
  ]);

  // 2) name → id 변환 (없는 컬럼은 무시)
  const productPropIds = PRODUCT_PROPS_NEEDED
    .map(n => productSchema[n]).filter(Boolean);
  const orderPropIds = ORDER_PROPS_NEEDED
    .map(n => orderSchema[n]).filter(Boolean);

  // 3) 슈즈 + 최근 N년 — filter_properties로 가벼운 응답만
  const products = await queryAll(PRODUCT_DS_ID, headers, {
    filter: {
      and: [
        { property: '의류/슈즈/잡화', select: { equals: '슈즈' } },
        { or: TARGET_YEARS.map(y => ({ property: '개발년도', select: { equals: y } })) }
      ]
    }
  }, productPropIds);

  // 4) 발주 — 청크 병렬 (Promise.all) + filter_properties
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
    return queryAll(ORDER_DS_ID, headers, { filter }, orderPropIds);
  }));
  const orders = chunkResults.flat();

  // 5) 제품별 발주 그룹화
  const ordersByProduct = {};
  for (const o of orders) {
    const rels = (o.properties['관계형 title']?.relation) || [];
    for (const r of rels) {
      if (!ordersByProduct[r.id]) ordersByProduct[r.id] = [];
      ordersByProduct[r.id].push(o);
    }
  }

  // 6) 정제된 가벼운 구조로 매핑 (빈 값 제거)
  return products.map((p, i) =>
    compactProduct(mapProduct(p, ordersByProduct[p.id] || [], i + 1))
  );
}

// ───────────── Schema fetch + 캐시 ─────────────

async function getSchemaCached(key, dsId, headers) {
  const now = Date.now();
  if (schemaCache[key] && (now - schemaCache.timestamp) < SCHEMA_TTL) {
    return schemaCache[key];
  }
  const r = await fetch(`https://api.notion.com/v1/data_sources/${dsId}`, { headers });
  const data = await r.json();
  if (!r.ok) throw new Error(`Schema fetch failed: ${data.message || JSON.stringify(data)}`);
  const map = {};
  for (const [name, prop] of Object.entries(data.properties)) {
    map[name] = prop.id;
  }
  schemaCache[key] = map;
  schemaCache.timestamp = now;
  return map;
}

// ───────────── Query (filter_properties 지원) ─────────────

async function queryAll(dsId, headers, body, filterProps) {
  const all = [];
  let cursor;
  let url = `https://api.notion.com/v1/data_sources/${dsId}/query`;
  if (filterProps && filterProps.length > 0) {
    const params = filterProps.map(id => `filter_properties=${encodeURIComponent(id)}`).join('&');
    url += '?' + params;
  }
  do {
    const reqBody = { ...body, page_size: 100 };
    if (cursor) reqBody.start_cursor = cursor;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(reqBody) });
    const data = await r.json();
    if (!r.ok) throw new Error(`Notion query failed: ${data.message || JSON.stringify(data)}`);
    all.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return all;
}

// ───────────── 헬퍼 ─────────────

function getText(prop) {
  if (!prop) return '';
  if (prop.type === 'title')     return (prop.title     || []).map(t => t.plain_text).join('');
  if (prop.type === 'rich_text') return (prop.rich_text || []).map(t => t.plain_text).join('');
  return '';
}

function getImg(prop) {
  const f = prop?.files?.[0];
  if (!f) return null;
  if (f.type === 'file')     return f.file.url;
  if (f.type === 'external') return f.external.url;
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
  const histText = getText(p['히스토리']);

  return {
    id:       idx,
    name:    getText(p['제품명']) || '(이름 없음)',
    style:   getText(p['품번']) || `OZK-${String(idx).padStart(4, '0')}`,
    brand:   p['브랜드']?.select?.name || '오즈키즈',
    vendor:  p['생산공장']?.select?.name || '',
    region:  p['원산지']?.select?.name || '',
    year:    parseInt(p['개발년도']?.select?.name) || new Date().getFullYear(),
    cat:     p['복종']?.select?.name || '',
    season:  p['시즌']?.multi_select?.[0]?.name || '',
    status:  simplifyStatus(p['진행상태']?.status?.name),
    last:    getText(p['라스트']),
    type:    p['제품유형']?.multi_select?.[0]?.name || '',
    gender:  p['성별']?.select?.name || null,
    moq:     p['MOQ']?.number || null,
    img:     getImg(p['대표이미지']),
    uc:      p['원가']?.number || 0,
    rt:      p['판매가']?.number || 0,
    ed:      p['입고일']?.date?.start || '',
    fabric:    getText(p['원단명']),
    supplies:  parseLines(getText(p['부자재 구매'])),
    kcStatus:  p['KC진행']?.select?.name || '',
    kcFiles:   (p['KC 시험성적서']?.files || []).map(f => ({
      name: f.name || 'KC 서류',
      url:  f.type === 'file' ? f.file?.url : (f.external?.url || null)
    })).filter(f => f.url),
    rem: parseLines(remText),
    ord,
    hist: histText
      ? histText.split('\n').map(line => {
          const parts = line.split('|').map(s => s.trim());
          if (parts.length < 2) return null;
          return { d: parts[0], t: parts[1], b: parts[2] || '' };
        }).filter(Boolean)
      : []
  };
}

// 응답 압축 — null/undefined와 'kcFiles/supplies' 빈 배열만 제거
// (ord/rem/hist 빈 배열은 보존 — 클라이언트가 .map 직접 호출하므로)
function compactProduct(obj) {
  const result = {};
  const preserveEmpty = new Set(['ord', 'rem', 'hist']);
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0 && !preserveEmpty.has(k)) continue;
    if (typeof v === 'string' && v === '') continue;
    result[k] = v;
  }
  return result;
}
