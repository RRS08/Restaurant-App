/* Valley Carriers — animated coverage map.
   Extracted from the prototype (coverage-map-demo.html) and parameterized so it
   can mount inside the Checked renderer. Requires d3 v7 and topojson-client v3
   to be loaded first (self-hosted copies alongside this file).

   Usage:
     VCCoverageMap('#vc-coverage', {
       compact: window.innerWidth < 760,          // squarer box + bigger type
       dataUrl: '/assets/valley/countries-110m.json'
     });
*/
window.VCCoverageMap = function (selector, opts) {
  opts = opts || {};
  const COMPACT = !!opts.compact;
  const REDUCED = opts.reduced != null ? !!opts.reduced
    : matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DATA_URL = opts.dataUrl || '/assets/valley/countries-110m.json';

  const W = COMPACT ? 880 : 1400;
  const H = COMPACT ? 660 : 700;
  const F = COMPACT ? 2.0 : 1;

  const SPEED = 78;
  const DASH  = 74;

  const T = {
    context:'#E4DFD5', focus:'#FFFFFF', edge:'#14171A',
    lane:'#14171A', laneP:0.32, laneR:0.16,
    planned:'#A9A197', pulse:'#C40125', hub:'#14171A',
    label:'#6E767C', crossing:'#C40125', crossingText:'#14171A',
    legend:'#6E767C', ring:'#F6F4F0'
  };
  const FONT = "'Schibsted Grotesk', system-ui, sans-serif";

  const CROSSINGS = [
    { name:'Pharr',       lon:-98.183, lat:26.203, dx: 16, dy:-8, anchor:'start' },
    { name:'Brownsville', lon:-97.497, lat:25.901, dx: 16, dy: 20, anchor:'start' }
  ];

  const HUBS = [
    { name:'Reynosa',   lon:-98.288, lat:26.081 },
    { name:'Matamoros', lon:-97.503, lat:25.869 },
    { name:'Monterrey', lon:-100.316, lat:25.687, label:true, planned:true, dx:-11, dy:-24, anchor:'end' },
    { name:'Miami',        lon:-80.191, lat:25.761, label:true, dx:13, dy:5 },
    { name:'Houston',      lon:-95.369, lat:29.760, label:true, dx:12, dy:14 },
    { name:'Dallas',       lon:-96.797, lat:32.777, label:true, dx:12, dy:-6 },
    { name:'Nashville',    lon:-86.784, lat:36.166, label:true, dx:12, dy:-6 },
    { name:'Los Angeles',  lon:-118.037, lat:33.817, label:true, dx:-12, dy:-6, anchor:'end' },
    { name:'Austin',       lon:-97.743, lat:30.267 },
    { name:'San Antonio',  lon:-98.494, lat:29.424 },
    { name:'Lubbock',      lon:-101.855, lat:33.577 },
    { name:'Tulsa',        lon:-95.993, lat:36.154 },
    { name:'Owensboro',    lon:-87.113, lat:37.774 },
    { name:'Ravenswood',   lon:-81.760, lat:38.947 },
    { name:'WinstonSalem', lon:-80.244, lat:36.100 },
    { name:'Orlando',      lon:-81.379, lat:28.538 },
    { name:'FortMyers',    lon:-81.873, lat:26.640 },
    { name:'Jacksonville', lon:-81.656, lat:30.332 },
    { name:'Columbus',     lon:-82.999, lat:39.961 },
    { name:'Boise',        lon:-116.201, lat:43.615 },
    { name:'Seattle',      lon:-122.332, lat:47.606, label:true, dx:12, dy:-6 },
    { name:'SaltLake',     lon:-111.891, lat:40.760 },
    { name:'SaintPaul',    lon:-93.087, lat:44.954 },
    { name:'NewJersey',    lon:-74.360, lat:40.460 },
    { name:'Tampa',        lon:-82.458, lat:27.947 },
    { name:'BatonRouge',   lon:-91.187, lat:30.451 },
    { name:'Columbia',     lon:-81.035, lat:34.001 },
    { name:'OklahomaCity', lon:-97.517, lat:35.467 }
  ];

  const byName = {};
  CROSSINGS.concat(HUBS).forEach(c => byName[c.name] = c);

  const GULF = [[-97.30,28.20],[-95.37,29.76],[-91.15,30.45],[-86.50,30.90]];
  const SE   = [[-95.37,29.76],[-90.07,32.30]];

  const LANES = [
    { from:'Pharr', to:'Houston', weight:2, via:[[-97.60,27.90]] },
    { from:'Pharr', to:'Dallas', weight:2, via:[[-98.00,28.60]] },
    { from:'Matamoros', to:'Austin', weight:1 },
    { from:'Pharr', to:'San Antonio', weight:1 },
    { from:'Pharr', to:'Lubbock', weight:1, via:[[-99.50,29.50]] },
    { from:'Pharr', to:'Tulsa', weight:1, via:[[-97.20,31.10]] },
    { from:'Pharr', to:'Miami', weight:2, via:GULF.concat([[-83.20,29.90],[-81.38,28.10]]) },
    { from:'Pharr', to:'Orlando', weight:1, via:GULF.concat([[-83.60,29.80]]) },
    { from:'Pharr', to:'FortMyers', weight:1, via:GULF.concat([[-83.40,29.40]]) },
    { from:'Pharr', to:'Jacksonville', weight:1, via:GULF },
    { from:'Pharr', to:'Nashville', weight:1, via:SE },
    { from:'Brownsville', to:'Owensboro', weight:1, via:SE.concat([[-88.00,35.00]]) },
    { from:'Brownsville', to:'Ravenswood', weight:1, via:SE.concat([[-86.78,36.17]]) },
    { from:'Pharr', to:'WinstonSalem', weight:1, via:SE.concat([[-84.39,33.75]]) },
    { from:'Pharr', to:'Columbus', weight:1, via:[[-95.37,29.76],[-90.20,38.60]] },
    { from:'Pharr', to:'Los Angeles', weight:2, via:[[-101.00,29.50],[-106.49,31.76],[-111.00,32.22]] },
    { from:'Pharr', to:'Boise', weight:1, via:[[-101.86,33.58],[-106.61,35.08],[-111.89,40.76]] },
    { from:'Pharr', to:'Tampa', weight:1, via:GULF.concat([[-83.40,29.20]]) },
    { from:'Pharr', to:'BatonRouge', weight:1, via:[[-97.30,28.20],[-95.37,29.76]] },
    { from:'Pharr', to:'Columbia', weight:1, via:SE.concat([[-84.39,33.75]]) },
    { from:'Pharr', to:'OklahomaCity', weight:1, via:[[-98.20,31.00]] },
    { from:'Pharr', to:'SaltLake', weight:1, via:[[-101.86,33.58],[-106.61,35.08]] },
    { from:'Pharr', to:'Seattle', weight:1, via:[[-103.00,33.50],[-110.00,39.00],[-117.00,45.00]] },
    { from:'Pharr', to:'SaintPaul', weight:1, via:[[-97.00,33.50],[-94.58,39.10]] },
    { from:'Pharr', to:'NewJersey', weight:1, via:[[-95.37,29.76],[-88.00,35.50],[-81.00,38.50]] },
    { from:'Pharr', to:'Monterrey', weight:0 }
  ];

  const svg = d3.select(selector).append('svg')
    .attr('viewBox', '0 0 ' + W + ' ' + H)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  const frame = { type:'MultiPoint', coordinates:[[-124,48.5],[-68,48.5],[-124,17],[-68,17]] };
  const projection = d3.geoMercator().fitExtent([[24,24],[W-24,H-24]], frame);
  const path = d3.geoPath(projection);
  const P = c => Array.isArray(c) ? projection(c) : projection([c.lon, c.lat]);

  function arc(a, b, lift){
    const [x1,y1] = P(a), [x2,y2] = P(b);
    const dx = x2-x1, dy = y2-y1, len = Math.hypot(dx,dy) || 1;
    const mx = (x1+x2)/2 + (-dy/len)*len*lift;
    const my = (y1+y2)/2 + ( dx/len)*len*lift;
    return 'M'+x1+','+y1+' Q'+mx+','+my+' '+x2+','+y2;
  }
  const smooth = d3.line().curve(d3.curveCatmullRom.alpha(0.5));

  d3.json(DATA_URL).then(topology => {
    const countries = topojson.feature(topology, topology.objects.countries).features;
    const focus = new Set(['United States of America','Mexico']);
    const g = svg.append('g');

    g.append('g').selectAll('path')
      .data(countries.filter(d => !focus.has(d.properties.name))).join('path')
      .attr('d', path).attr('fill', T.context).attr('stroke', '#F6F4F0').attr('stroke-width', 1);

    g.append('g').selectAll('path')
      .data(countries.filter(d => focus.has(d.properties.name))).join('path')
      .attr('d', path).attr('fill', T.focus).attr('stroke', T.edge)
      .attr('stroke-width', 1.4).attr('stroke-linejoin','round');

    const laneLayer  = g.append('g').attr('fill','none').attr('stroke-linecap','round');
    const pulseLayer = g.append('g').attr('fill','none').attr('stroke-linecap','round');
    const dotLayer   = g.append('g');

    const lanes = [];
    LANES.forEach((L, i) => {
      const a = byName[L.from], b = byName[L.to];
      if(!a || !b) return;
      const d = L.via && L.via.length
        ? smooth([P(a)].concat(L.via.map(P), [P(b)]))
        : arc(a, b, i % 2 === 0 ? 0.055 : -0.045);
      const planned = L.weight === 0;
      const base = laneLayer.append('path')
        .attr('d', d)
        .attr('stroke', planned ? T.planned : T.lane)
        .attr('stroke-width', L.weight === 2 ? 1.7 : 1.1)
        .attr('stroke-opacity', planned ? 1 : (L.weight === 2 ? T.laneP : T.laneR))
        .attr('stroke-dasharray', planned ? '7 6' : null);
      if(planned && !REDUCED){
        base.append('animate').attr('attributeName','stroke-dashoffset')
          .attr('from', 13).attr('to', 0).attr('dur','1.25s').attr('repeatCount','indefinite');
      }
      lanes.push({ d, weight:L.weight, planned, len: base.node().getTotalLength(), base, order:i });
    });

    if(!REDUCED){
      lanes.filter(l => !l.planned).forEach(l => {
        l.base.attr('stroke-dasharray', l.len+' '+l.len).attr('stroke-dashoffset', l.len)
          .transition().delay(260 + l.order*90).duration(900).ease(d3.easeCubicOut)
          .attr('stroke-dashoffset', 0)
          .on('end', function(){ d3.select(this).attr('stroke-dasharray', null); });
      });

      lanes.filter(l => !l.planned).forEach(l => {
        const trace = pulseLayer.append('path').attr('d', l.d)
          .attr('stroke', T.pulse)
          .attr('stroke-width', l.weight === 2 ? 2.2 : 1.5)
          .attr('stroke-opacity', l.weight === 2 ? 0.95 : 0.6)
          .attr('stroke-dasharray', DASH+' '+l.len);
        const dur = (l.len / SPEED) * 1000;
        let back = false;
        const run = first => {
          trace.attr('stroke-dashoffset', back ? -DASH : l.len + DASH)
            .transition().delay(first ? 900 + l.order*190 : 1100)
            .duration(dur).ease(d3.easeLinear)
            .attr('stroke-dashoffset', back ? l.len + DASH : -DASH)
            .on('end', () => { back = !back; run(false); });
        };
        run(true);
      });

      lanes.filter(l => l.weight === 2).forEach(l => {
        const node = l.base.node();
        const s = node.getPointAtLength(0);
        const dot = dotLayer.append('circle').attr('r', 3.6*F).attr('fill', T.pulse)
          .attr('stroke', T.ring).attr('stroke-width', 1.2*F).attr('opacity', 0)
          .attr('transform', 'translate('+s.x+','+s.y+')');
        const dur = (l.len / SPEED) * 1000;
        let back = false;
        const run = first => dot.transition().delay(first ? 900 + l.order*190 : 1100)
          .duration(0).attr('opacity', 1).transition()
          .duration(dur).ease(d3.easeLinear)
          .attrTween('transform', () => t => {
            const p = node.getPointAtLength((back ? 1 - t : t) * l.len);
            return 'translate('+p.x+','+p.y+')';
          })
          .on('end', () => { dot.attr('opacity', 0); back = !back; run(false); });
        run(true);
      });
    }

    HUBS.forEach(c => {
      const [x,y] = P(c);
      dotLayer.append('circle').attr('cx',x).attr('cy',y)
        .attr('r', c.label ? 4*F : 2.2*F)
        .attr('fill', c.planned ? T.ring : T.hub)
        .attr('fill-opacity', c.label ? 1 : 0.45)
        .attr('stroke', c.planned ? T.planned : 'none').attr('stroke-width', 1.6*F);
      if(!c.label) return;
      dotLayer.append('text')
        .attr('x', x + (c.dx || 10)*F).attr('y', y + (c.dy || 5)*F)
        .attr('text-anchor', c.anchor || 'start')
        .attr('font-family', FONT).attr('font-size', 13*F).attr('font-weight', 500)
        .attr('letter-spacing', -0.1).attr('fill', T.crossingText).text(c.name);
      if(c.planned && !COMPACT){
        dotLayer.append('text')
          .attr('x', x + (c.dx || 10)).attr('y', y + (c.dy || 5) + 14)
          .attr('text-anchor', c.anchor || 'start')
          .attr('font-family', FONT).attr('font-size', 11).attr('letter-spacing', 1.1)
          .attr('fill', T.planned).text('PLANNED');
      }
    });

    const cr = g.append('g');
    CROSSINGS.forEach((c, i) => {
      const [x,y] = P(c);
      if(!REDUCED){
        const ring = cr.append('rect').attr('fill','none')
          .attr('stroke', T.crossing).attr('stroke-width', 1.6*F);
        const beat = () => ring
          .attr('x', x-5*F).attr('y', y-5*F).attr('width', 10*F).attr('height', 10*F)
          .attr('stroke-opacity', 0.85)
          .transition().delay(i*420).duration(2000).ease(d3.easeCubicOut)
          .attr('x', x-20*F).attr('y', y-20*F).attr('width', 40*F).attr('height', 40*F)
          .attr('stroke-opacity', 0).on('end', beat);
        beat();
      }
      cr.append('rect').attr('x', x-5*F).attr('y', y-5*F)
        .attr('width', 10*F).attr('height', 10*F).attr('fill', T.crossing);
      cr.append('text').attr('x', x + c.dx*F).attr('y', y + c.dy*F)
        .attr('text-anchor', c.anchor).attr('font-family', FONT)
        .attr('font-size', 14*F).attr('font-weight', 700).attr('letter-spacing', 0.3)
        .attr('fill', T.crossingText).text(c.name.toUpperCase());
    });

    const rows = [
      { t:'BORDER CROSSING', mark:'sq' },
      { t:'RUNNING LANE',    mark:'solid' },
      { t:'PLANNED',         mark:'dash' }
    ];
    const lg = svg.append('g')
      .attr('transform','translate('+(24*F)+','+(H - (28 + rows.length*22)*F)+')');
    rows.forEach((r, i) => {
      const y = i*22*F;
      if(r.mark === 'sq'){
        lg.append('rect').attr('x',0).attr('y',y-4*F)
          .attr('width',8*F).attr('height',8*F).attr('fill',T.crossing);
      } else {
        lg.append('line').attr('x1',0).attr('x2',16*F).attr('y1',y).attr('y2',y)
          .attr('stroke', r.mark === 'solid' ? T.lane : T.planned)
          .attr('stroke-opacity', r.mark === 'solid' ? T.laneP : 1)
          .attr('stroke-width', 1.7*F)
          .attr('stroke-dasharray', r.mark === 'dash' ? (5*F)+' '+(4*F) : null);
      }
      lg.append('text').attr('x', 26*F).attr('y', y+4*F)
        .attr('font-family', FONT).attr('font-size', 11*F)
        .attr('letter-spacing', 1.3).attr('fill', T.legend).text(r.t);
    });

    if(!COMPACT){
      const mainCentroid = name => {
        const f = countries.find(d => d.properties.name === name);
        const polys = f.geometry.type === 'MultiPolygon'
          ? f.geometry.coordinates : [f.geometry.coordinates];
        let best = null, bestA = -1;
        for(const coords of polys){
          const a = Math.abs(path.area({ type:'Polygon', coordinates: coords }));
          if(a > bestA){ bestA = a; best = coords; }
        }
        const ring = best[0].map(c => P(c)).filter(p => p && isFinite(p[0]));
        let x0=Infinity, y0=Infinity, x1=-Infinity, y1=-Infinity;
        for(const [x,y] of ring){
          if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
        }
        const inside = (px,py) => {
          let c = false;
          for(let i=0, j=ring.length-1; i<ring.length; j=i++){
            const [xi,yi] = ring[i], [xj,yj] = ring[j];
            if((yi>py) !== (yj>py) && px < (xj-xi)*(py-yi)/(yj-yi||1e-9)+xi) c = !c;
          }
          return c;
        };
        const edgeDist = (px,py) => {
          let m2 = Infinity;
          for(let i=0, j=ring.length-1; i<ring.length; j=i++){
            const [xi,yi] = ring[i], [xj,yj] = ring[j];
            const dx = xj-xi, dy = yj-yi;
            const t = Math.max(0, Math.min(1, ((px-xi)*dx + (py-yi)*dy) / (dx*dx+dy*dy || 1e-9)));
            const ex = xi + t*dx - px, ey = yi + t*dy - py;
            const d = ex*ex + ey*ey;
            if(d < m2) m2 = d;
          }
          return m2;
        };
        let bx=(x0+x1)/2, by=(y0+y1)/2, bd=-1;
        const N = 72;
        for(let i=0; i<=N; i++){
          for(let j=0; j<=N; j++){
            const px = x0 + (x1-x0)*i/N, py = y0 + (y1-y0)*j/N;
            if(!inside(px,py)) continue;
            const d = edgeDist(px,py);
            if(d > bd){ bd = d; bx = px; by = py; }
          }
        }
        return [bx, by];
      };
      const rlxy = (xy, txt) => {
        const [x,y] = xy;
        svg.append('text').attr('x',x).attr('y',y).attr('text-anchor','middle')
          .attr('font-family', FONT).attr('font-size', 14)
          .attr('letter-spacing', 4.2).attr('fill','#C2BBAE').text(txt);
      };
      rlxy(mainCentroid('United States of America'), 'UNITED STATES');
      rlxy(mainCentroid('Mexico'), 'MEXICO');
    }
  }).catch(err => {
    d3.select(selector).append('div')
      .style('padding','24px').style('font-family', FONT)
      .style('font-size','12px').style('color','#8B9096')
      .text('Map data unavailable offline.');
    console.error(err);
  });
};
