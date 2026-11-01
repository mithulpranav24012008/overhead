// The 3D stage: a printed globe and a point for every object. It's told where things are and knows nothing about orbits.
import * as THREE from "three";
import { feature } from "topojson-client";
import land from "world-atlas/land-110m.json";

const INK = new THREE.Color("#ff99d3"), PALE = new THREE.Color("#ffd23f"), DOT = new THREE.Color("#ffd6ec");
const FOV = 30;

function landMask() {
  const canvas = document.createElement("canvas");
  canvas.width = 2048; canvas.height = 1024;
  const g = canvas.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, 2048, 1024);
  g.fillStyle = "#fff";
  const geo = feature(land, land.objects.land);
  const X = (lon) => ((lon + 180) / 360) * 2048, Y = (lat) => ((90 - lat) / 180) * 1024;
  for (const f of geo.features ?? [geo]) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      // A coastline can cross the map's edge. Follow it unbroken past the edge, then draw it again one map-width either side.
      for (const offset of [-360, 0, 360]) {
        g.beginPath();
        for (const ring of poly) {
          let previous = null, shift = 0;
          ring.forEach(([lon, lat], i) => {
            if (previous !== null && Math.abs(lon - previous) > 180) shift += lon < previous ? 360 : -360;
            previous = lon;
            const x = X(lon + shift + offset), y = Y(lat);
            if (i) g.lineTo(x, y); else g.moveTo(x, y);
          });
        }
        g.fill("evenodd");
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = false;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

export function createGlobe(canvas, count) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 400);
  const sun = new THREE.Vector3(1, 0, 0);

  // ---- Earth: land drawn as printed dots, lit by where the Sun really is ----
  const earthMat = new THREE.ShaderMaterial({
    uniforms: { mask: { value: landMask() }, sun: { value: sun }, ink: { value: INK }, rows: { value: 180 } },
    vertexShader: /* glsl */ `
      varying vec3 vLocal; varying vec3 vWorld;
      void main() {
        vLocal = position;
        vWorld = mat3(modelMatrix) * position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D mask; uniform vec3 sun; uniform vec3 ink; uniform float rows;
      varying vec3 vLocal; varying vec3 vWorld;
      const float PI = 3.14159265;
      void main() {
        vec3 n = normalize(vLocal);
        float lat = asin(clamp(n.y, -1.0, 1.0));
        float lon = atan(-n.z, n.x);
        float gap = PI / rows;
        float row = floor((lat + PI / 2.0) / gap);
        float rowLat = -PI / 2.0 + (row + 0.5) * gap;
        float cols = max(1.0, floor(2.0 * rows * cos(rowLat)));
        float colStep = 2.0 * PI / cols;
        float col = floor((lon + PI) / colStep);
        float dotLon = -PI + (col + 0.5) * colStep;
        float dx = (lon - dotLon) * cos(lat);
        float dist = length(vec2(dx, lat - rowLat));
        float isLand = texture2D(mask, vec2((dotLon + PI) / (2.0 * PI), (rowLat + PI / 2.0) / PI)).r;
        float pixel = length(vec2(length(dFdx(n)), length(dFdy(n))));
        float dotShape = 1.0 - smoothstep(gap * 0.34 - pixel, gap * 0.34 + pixel, dist);
        // Dots too small to draw separately settle to the tone they'd average to.
        float fine = smoothstep(gap * 0.45, gap * 1.1, pixel);
        float landTone = mix(dotShape, 0.36, fine) * step(0.5, isLand);
        float day = smoothstep(-0.08, 0.1, dot(normalize(vWorld), sun));
        vec3 sea = mix(vec3(0.075, 0.0, 0.013), vec3(0.135, 0.002, 0.02), day);
        vec3 inked = mix(ink * 0.14, ink * 0.5, day); // well under the satellites, which are the point
        gl_FragColor = vec4(mix(sea, inked, landTone), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), earthMat);
  scene.add(earth);

  // ---- every object: one point, placed by the graphics card between two moments in time ----
  const geometry = new THREE.BufferGeometry();
  const a = new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const b = new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const fleet = new THREE.BufferAttribute(new Float32Array(count), 1);
  const height = new THREE.BufferAttribute(new Float32Array(count), 1);
  geometry.setAttribute("position", a);
  geometry.setAttribute("posB", b);
  geometry.setAttribute("fleet", fleet);
  geometry.setAttribute("meanHeight", height);
  const dots = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { blend: { value: 0 }, sun: { value: sun }, pick: { value: -1 }, ceiling: { value: 1e6 }, px: { value: 1 }, ink: { value: DOT }, pale: { value: PALE } },
    vertexShader: /* glsl */ `
      attribute vec3 posB; attribute float fleet; attribute float meanHeight;
      uniform float blend, pick, ceiling, px; uniform vec3 sun;
      varying float vAlpha; varying float vChosen;
      void main() {
        vec3 p = mix(position, posB, blend);
        float r = length(p);
        vChosen = (pick >= 0.0 && abs(fleet - pick) < 0.5) ? 1.0 : 0.0;
        if (r < 0.5 || meanHeight > ceiling) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; return; }
        float along = dot(p, sun);
        float shadowed = (along < 0.0 && length(p - along * sun) < 1.0) ? 1.0 : 0.0;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float faded = pick >= 0.0 && vChosen < 0.5 ? 0.2 : 1.0;
        vAlpha = mix(1.0, 0.42, shadowed) * faded;
        gl_PointSize = px * clamp(7.0 / -mv.z, 1.5, 4.5) * (vChosen > 0.5 ? 1.45 : 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 ink, pale; varying float vAlpha; varying float vChosen;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5 || vAlpha <= 0.0) discard;
        gl_FragColor = vec4(mix(ink, pale, vChosen), vAlpha * (1.0 - smoothstep(0.34, 0.5, d)));
        #include <colorspace_fragment>
      }`,
  });
  const points = new THREE.Points(geometry, dots);
  points.frustumCulled = false;
  scene.add(points);

  // ---- the chosen object: a ring, and the path of its orbit ----
  const ringGeo = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
  const ring = new THREE.Points(ringGeo, new THREE.ShaderMaterial({
    transparent: true, depthTest: false,
    uniforms: { px: { value: 1 }, pale: { value: PALE } },
    vertexShader: "uniform float px; void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = 26.0 * px; }",
    fragmentShader: `uniform vec3 pale; void main() {
      float d = length(gl_PointCoord - 0.5);
      float w = fwidth(d);
      float a = smoothstep(0.43 - w, 0.43, d) * (1.0 - smoothstep(0.48, 0.48 + w, d)) + (1.0 - smoothstep(0.1, 0.1 + w, d));
      if (a <= 0.0) discard;
      gl_FragColor = vec4(pale, a);
      #include <colorspace_fragment>
    }`,
  }));
  ring.frustumCulled = false;
  ring.visible = false;
  ring.renderOrder = 3;
  scene.add(ring);
  const path = new THREE.Line(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(181 * 3), 3)), new THREE.LineBasicMaterial({ color: PALE, transparent: true, opacity: 0.75 }));
  path.frustumCulled = false;
  path.visible = false;
  scene.add(path);
  // Your city: a small pale ring fixed to the turning Earth.
  const homeGeo = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
  const home = new THREE.Points(homeGeo, new THREE.ShaderMaterial({
    transparent: true, uniforms: { px: { value: 1 }, pale: { value: PALE } },
    vertexShader: "uniform float px; void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = 13.0 * px; }",
    fragmentShader: `uniform vec3 pale; void main() {
      float d = length(gl_PointCoord - 0.5), w = fwidth(d);
      float a = 1.0 - smoothstep(0.42, 0.42 + w, d);
      if (a <= 0.0) discard;
      gl_FragColor = vec4(mix(pale, vec3(0.05, 0.0, 0.01), smoothstep(0.2, 0.2 + w, d) * (1.0 - smoothstep(0.33, 0.33 + w, d))), a);
      #include <colorspace_fragment>
    }`,
  }));
  home.frustumCulled = false;
  earth.add(home);

  const size = { w: 1, h: 1 };
  const look = new THREE.Vector3();
  const unit = new THREE.Vector3();
  const self = {
    renderer, scene, camera, earth, FOV,
    count,
    keys: [a, b],
    setKey(which, array) { const attr = this.keys[which]; attr.array.set(array); attr.needsUpdate = true; },
    setFleets(array) { fleet.array.set(array); fleet.needsUpdate = true; },
    setHeights(array) { height.array.set(array); height.needsUpdate = true; },
    setBlend(v) { dots.uniforms.blend.value = v; },
    setSun(s) { sun.set(s.x, s.z, -s.y).normalize(); },
    setRotation(gmst) { earth.rotation.y = gmst; },
    highlightFleet(i) { dots.uniforms.pick.value = i; },
    setCeiling(km) { dots.uniforms.ceiling.value = km; },
    setHome(lat, lon) {
      const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
      const arr = homeGeo.attributes.position;
      arr.setXYZ(0, Math.cos(la) * Math.cos(lo) * 1.002, Math.sin(la) * 1.002, -Math.cos(la) * Math.sin(lo) * 1.002);
      arr.needsUpdate = true;
    },
    setChosen(p) {
      ring.visible = !!p;
      if (p) { ringGeo.attributes.position.setXYZ(0, p.x, p.y, p.z); ringGeo.attributes.position.needsUpdate = true; }
    },
    setPath(list) {
      path.visible = !!list;
      if (!list) return;
      const attr = path.geometry.attributes.position;
      list.forEach((p, i) => attr.setXYZ(i, p.x, p.y, p.z));
      attr.needsUpdate = true;
      path.geometry.setDrawRange(0, list.length);
    },
    resize(w, h) {
      size.w = w; size.h = h;
      const ratio = Math.min(devicePixelRatio, w < 700 ? 1.75 : 2);
      renderer.setPixelRatio(ratio);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      const px = ratio * Math.max(0.85, Math.min(1.25, Math.min(w, h) / 800));
      dots.uniforms.px.value = w < 700 ? px * 1.3 : px; // phone screens are small, so the dots need to be bigger to read
      ring.material.uniforms.px.value = ratio;
      home.material.uniforms.px.value = ratio;
    },
    // shift moves the whole picture sideways as a share of the width.
    place(az, el, dist, shiftX, shiftY = 0) {
      const sa = Math.sin(az), ca = Math.cos(az), se = Math.sin(el), ce = Math.cos(el);
      camera.position.set(sa * ce * dist, se * dist, ca * ce * dist);
      camera.up.set(-sa * se, ce, -ca * se);
      camera.lookAt(look);
      camera.near = Math.max(0.05, dist - 7.5 > 0.2 ? (dist - 7.5) * 0.5 : 0.05);
      camera.far = dist + 60;
      camera.setViewOffset(size.w, size.h, -size.w * shiftX, -size.h * shiftY, size.w, size.h);
      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
    },
    // Where a scene position lands on the canvas, and whether the Earth hides it.
    project(x, y, z, out) {
      unit.set(x, y, z).project(camera);
      out.x = ((unit.x + 1) / 2) * size.w;
      out.y = ((1 - unit.y) / 2) * size.h;
      out.front = unit.z < 1;
      // The line from the camera to the point passes through the unit sphere?
      const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const len2 = dx * dx + dy * dy + dz * dz;
      const t = -(cx * dx + cy * dy + cz * dz) / len2;
      const nx = cx + dx * t, ny = cy + dy * t, nz = cz + dz * t;
      out.hidden = t > 0 && t < 1 && nx * nx + ny * ny + nz * nz < 1;
      return out;
    },
    render() { renderer.render(scene, camera); },
  };
  return self;
}
