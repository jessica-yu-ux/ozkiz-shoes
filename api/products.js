// OZKIZ Shoes 작업지시서 — 노션 → 사이트 데이터 변환
// Vercel Serverless Function
//
// 노션 API 키는 Vercel 환경변수 NOTION_TOKEN에서 읽음 (코드에 박지 않음)

const NOTION_VERSION = '2025-09-03';
const PRODUCT_DS_ID = '09981565-42db-4946-a747-13ea92c3d772';   // 제품 DB
const ORDER_DS_ID   = '5d13f212-7945-4177-ba16-7b0f8a47bc56';   // 오즈키즈 발주 DB

module.exports = async function handler(req, res) {
  try {
    const token = process.env.NOTION_TOKEN;
    if (!token) {
      return res.status(500).json({
        error: 'NOTION_TOKEN 환경변수가 설정되지 않았습니다. Vercel 대시보드에서 등록해주세요.'
      });
    }

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    };

    // 1) 슈즈 + 최근 N년 제품만 조회
    //    제품 DB에 1000+개 누적돼서 timeout 방지 — 아래 년도만 수정하면 범위 조정 가능
    const TARGET_YEARS = ['2025', '2026', '2027'];
    const products = await queryAll(PRODUCT_DS_ID, headers, {
      filter: {
        and: [
          { property: '의류/슈즈/잡화', select: { equals: '슈즈' } },
          { or: TARGET_YEARS.map(y => ({ property: '개발년도', select: { equals: y } })) }
        ]
      }
    });

    // 2) 슈즈 제품 ID로 발주만 필터링 — 청크들을 병렬 호출해서 빠르게
    const productIds = products.map(p => p.id);
    const CHUNK = 50;  // 노션 OR filter는 100개까지 — 안전하게 50개씩
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

    // 3) 제품별 발주 그룹화
    const ordersByProduct = {};
    for (const o of orders) {
      const rels = (o.properties['관계형 title']?.relation) || [];
      for (const r of rels) {
        if (!ordersByProduct[r.id]) ordersByProduct[r.id] = [];
        ordersByProduct[r.id].push(o);
      }
    }

    // 4) HTML의 PRODS 형식으로 변환
    const result = products.map((p, i) =>
      mapProduct(p, ordersByProduct[p.id] || [], i + 1)
    );

    // CDN 캐시: 5분간 신선, 55분간 stale-while-revalidate
    // (노션 이미지 URL이 1시간 만료라서 그 안에 갱신)
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3300');
    res.status(200).json(result);
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
};

// ─────────────────────────── 헬퍼 ───────────────────────────

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

// 노션 진행상태 → HTML status 클래스에 맞는 단순 키워드
function simplifyStatus(s) {
  if (!s) return '대기';
  if (s.includes('계속판매')) return '계속판매';
  if (s.includes('생산중'))   return '생산중';
  if (s.includes('생산 요청') || s.includes('생산요청')) return '생산요청';
  if (s.includes('단종') || s.includes('완료')) return '완료';
  if (s.includes('취소')) return '진행취소';
  return '대기';
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

  // 특이사항 — 줄바꿈으로 분리해서 배열로
  const remText = getText(p['생산지시 특이사항']);
  const rem = remText
    ? remText.split('\n').map(l => l.trim()).filter(Boolean)
    : [];

  // 히스토리 — "YYYY-MM-DD | 내용 | 구분" 형식의 줄들
  const histText = getText(p['히스토리']);
  const hist = histText
    ? histText.split('\n').map(line => {
        const parts = line.split('|').map(s => s.trim());
        if (parts.length < 2) return null;
        return { d: parts[0], t: parts[1], b: parts[2] || '' };
      }).filter(Boolean)
    : [];

  return {
    // HTML 코드가 id를 숫자로 다루므로 인덱스 부여. 노션 UUID는 notionId에 보관.
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

    // 원가 (HTML에서 uv/us/ue/ur은 세부 단가지만 노션엔 통합 원가만 있음)
    uv: 0, us: 0, ue: 0, ur: 0,
    uc:      p['원가']?.number || 0,
    rt:      p['판매가']?.number || 0,
    ed:      p['입고일']?.date?.start || '',

    // 새 필드들 (작업지시서용)
    fabric:    getText(p['원단명']) || '',
    supplies:  parseLines(getText(p['부자재 구매'])),
    kcStatus:  p['KC진행']?.select?.name || '',
    kcFiles:   (p['KC 시험성적서']?.files || []).map(f => ({
      name: f.name || 'KC 서류',
      url:  f.type === 'file' ? f.file?.url : (f.external?.url || null)
    })).filter(f => f.url),

    rem, ord, hist
  };
};

function parseLines(text) {
  if (!text) return [];
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}
