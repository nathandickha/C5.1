// js/pool/shapes/lshapePool.js
import * as THREE from "https://esm.sh/three@0.158.0";
import { createPoolWater } from "../water.js";

const STEP_PRESET_WIDTH = 0.9; // metres: preset left/centre/right step width
const DEFAULT_BENCH2_EXTENSION = 0.6; // metres: second/full-width bench starts at 600 mm
const DEFAULT_DIAGONAL_STEP_SIZE = 0.45; // metres: diagonal corner step starts at 450 mm x 450 mm

function clampStepValue(value, min, max) {
  const n = Number(value);
  const lo = Number.isFinite(min) ? min : 0.05;
  const hi = Number.isFinite(max) && max > lo ? max : lo;
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function getBench2Extension(params) {
  const n = Number(params?.bench2Extension);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BENCH2_EXTENSION;
}

function getDiagonalStepSize(params, bench2Extension = getBench2Extension(params)) {
  const raw = Number(params?.diagonalStepSize ?? params?.stepWidth);
  const wanted = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DIAGONAL_STEP_SIZE;
  return clampStepValue(wanted, 0.05, bench2Extension);
}

function getStepFootprintLength(params, stepCount, stepLength) {
  const count = Math.max(0, Number(stepCount) | 0);
  if (count <= 0) return 0;

  const bench2Extension = getBench2Extension(params);
  const isDiagonal = (params?.stepShape === "diagonal" || params?.stepShape === "circular") && params?.stepPosition !== "center";
  const narrowRun = isDiagonal ? getDiagonalStepSize(params, bench2Extension) : stepLength;

  // Step index 0 and the full-width second bench both start from the entry wall.
  // Any following steps must chain from the live front edge of the second bench.
  if (count === 1) return narrowRun;
  return bench2Extension + Math.max(0, count - 2) * narrowRun;
}

function getStepLayout(params, spanMinY, spanMaxY, options = {}) {
  const fullWidth = Math.max(0.05, spanMaxY - spanMinY);
  const pos = params.stepPosition === "left" || params.stepPosition === "right" ? params.stepPosition : "center";

  // Preset behaviour:
  // - second step uses full pool width
  // - all other steps use a locked 900 mm width and align left/centre/right
  const configuredWidth = Number(params.stepWidth);
  const isDiagonal = (params?.stepShape === "diagonal" || params?.stepShape === "circular") && pos !== "center" && !options.fullWidth;
  const bench2Extension = getBench2Extension(params);
  const targetWidth = options.fullWidth
    ? fullWidth
    : (isDiagonal
        ? getDiagonalStepSize(params, bench2Extension)
        : (Number.isFinite(configuredWidth) && configuredWidth > 0 ? configuredWidth : STEP_PRESET_WIDTH));
  const maxNarrowWidth = isDiagonal ? Math.min(fullWidth, bench2Extension) : fullWidth;
  const width = Math.min(maxNarrowWidth, Math.max(0.05, targetWidth));

  let centerY = (spanMinY + spanMaxY) * 0.5;
  if (pos === "left") centerY = spanMinY + width * 0.5;
  if (pos === "right") centerY = spanMaxY - width * 0.5;
  return { width, centerY, position: pos, isFullWidth: !!options.fullWidth };
}


function buildSpaSnapEdgesFromPoints(points) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const pts = points
    .map((p) => (p?.isVector2 ? p.clone() : new THREE.Vector2(Number.isFinite(p?.x) ? p.x : 0, Number.isFinite(p?.y) ? p.y : 0)))
    .filter(Boolean);

  if (pts.length < 2) return [];

  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    area += p.x * q.y - q.x * p.y;
  }
  const ccw = area >= 0;

  const edges = [];
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % pts.length];
    if (!p0 || !p1 || p0.distanceToSquared(p1) <= 1e-10) continue;

    const tangent = p1.clone().sub(p0);
    const length = tangent.length();
    if (length <= 1e-6) continue;
    tangent.divideScalar(length);

    const normal = ccw
      ? new THREE.Vector2(-tangent.y, tangent.x)
      : new THREE.Vector2(tangent.y, -tangent.x);

    edges.push({
      p0: p0.clone(),
      p1: p1.clone(),
      center: p0.clone().add(p1).multiplyScalar(0.5),
      tangent,
      normal: normal.normalize(),
      length
    });
  }

  return edges;
}

function generateMeterUVsForBoxGeometry(geo, tileSize) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const uvs = new Float32Array(pos.count * 2);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(nrm.getX(i));
    const ay = Math.abs(nrm.getY(i));
    const az = Math.abs(nrm.getZ(i));

    let u = 0;
    let v = 0;
    if (az >= ax && az >= ay) {
      u = x / tileSize;
      v = y / tileSize;
    } else if (ay >= ax && ay >= az) {
      u = x / tileSize;
      v = z / tileSize;
    } else {
      u = y / tileSize;
      v = z / tileSize;
    }

    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }

  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  if (!geo.attributes.uv2) {
    geo.setAttribute("uv2", new THREE.BufferAttribute(uvs.slice(), 2));
  }
}

function lineIntersection2D(a1, a2, b1, b2) {
  const dax = a2.x - a1.x;
  const day = a2.y - a1.y;
  const dbx = b2.x - b1.x;
  const dby = b2.y - b1.y;
  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 1e-8) return null;

  const dx = b1.x - a1.x;
  const dy = b1.y - a1.y;
  const t = (dx * dby - dy * dbx) / denom;
  return new THREE.Vector2(a1.x + dax * t, a1.y + day * t);
}

function createMiteredWallPrism(points, index, halfThickness, height) {
  const count = points.length;
  const pPrev = points[(index - 1 + count) % count];
  const p0 = points[index];
  const p1 = points[(index + 1) % count];
  const pNext = points[(index + 2) % count];

  const dir = p1.clone().sub(p0);
  if (dir.lengthSq() < 1e-10) return null;
  dir.normalize();

  const prevDir = p0.clone().sub(pPrev);
  if (prevDir.lengthSq() < 1e-10) prevDir.copy(dir);
  else prevDir.normalize();

  const nextDir = pNext.clone().sub(p1);
  if (nextDir.lengthSq() < 1e-10) nextDir.copy(dir);
  else nextDir.normalize();

  const leftNormal = (v) => new THREE.Vector2(-v.y, v.x);
  const curIn = leftNormal(dir);
  const prevIn = leftNormal(prevDir);
  const nextIn = leftNormal(nextDir);
  const curOut = curIn.clone().multiplyScalar(-1);
  const prevOut = prevIn.clone().multiplyScalar(-1);
  const nextOut = nextIn.clone().multiplyScalar(-1);

  const offsetLine = (a, b, normal, dist) => [
    a.clone().addScaledVector(normal, dist),
    b.clone().addScaledVector(normal, dist)
  ];

  const [curInnerA, curInnerB] = offsetLine(p0, p1, curIn, halfThickness);
  const [curOuterA, curOuterB] = offsetLine(p0, p1, curOut, halfThickness);
  const [prevInnerA, prevInnerB] = offsetLine(pPrev, p0, prevIn, halfThickness);
  const [prevOuterA, prevOuterB] = offsetLine(pPrev, p0, prevOut, halfThickness);
  const [nextInnerA, nextInnerB] = offsetLine(p1, pNext, nextIn, halfThickness);
  const [nextOuterA, nextOuterB] = offsetLine(p1, pNext, nextOut, halfThickness);

  let innerStart = lineIntersection2D(prevInnerA, prevInnerB, curInnerA, curInnerB) || curInnerA.clone();
  let outerStart = lineIntersection2D(prevOuterA, prevOuterB, curOuterA, curOuterB) || curOuterA.clone();
  let innerEnd = lineIntersection2D(curInnerA, curInnerB, nextInnerA, nextInnerB) || curInnerB.clone();
  let outerEnd = lineIntersection2D(curOuterA, curOuterB, nextOuterA, nextOuterB) || curOuterB.clone();

  const maxMiter = halfThickness * 8;
  if (innerStart.distanceTo(p0) > maxMiter) innerStart = curInnerA.clone();
  if (outerStart.distanceTo(p0) > maxMiter) outerStart = curOuterA.clone();
  if (innerEnd.distanceTo(p1) > maxMiter) innerEnd = curInnerB.clone();
  if (outerEnd.distanceTo(p1) > maxMiter) outerEnd = curOuterB.clone();

  const wallShape = new THREE.Shape([
    new THREE.Vector2(innerStart.x, innerStart.y),
    new THREE.Vector2(innerEnd.x, innerEnd.y),
    new THREE.Vector2(outerEnd.x, outerEnd.y),
    new THREE.Vector2(outerStart.x, outerStart.y)
  ]);

  const geo = new THREE.ExtrudeGeometry(wallShape, {
    depth: height,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1
  });
  // Match the stable wall-raise transform used by the custom/freeform pool walls:
  // keep the wall geometry centred on local Z so scaling raises the wall upward
  // without shearing or dropping the bottom anchor.
  geo.translate(0, 0, -height * 0.5);
  geo.computeVertexNormals();
  return geo;
}

function createStepGeometry(runLength, stepWidth, height, params, layout) {
  const shape = (params?.stepShape === "diagonal" || params?.stepShape === "circular") ? params.stepShape : "rectangle";
  const pos = layout?.position === "right" ? "right" : layout?.position === "left" ? "left" : "center";

  // The full-width second step remains rectangular so it can keep acting as the
  // continuous wall-backed bench/ledge.
  const isFullWidthStep = layout?.isFullWidth === true;
  if ((shape !== "diagonal" && shape !== "circular") || isFullWidthStep || pos === "center") {
    return new THREE.BoxGeometry(runLength, stepWidth, height);
  }

  // Use one single real-world size for diagonal corner steps. This keeps
  // the UI value honest: 0.60 m on the slider creates a 600 mm x 600 mm
  // triangular footprint, regardless of any old extension/width state.
  const bench2Extension = getBench2Extension(params);
  const size = THREE.MathUtils.clamp(
    Math.min(Number(runLength) || 0, Number(stepWidth) || 0) || DEFAULT_DIAGONAL_STEP_SIZE,
    0.05,
    bench2Extension
  );
  const x0 = -size * 0.5;
  const x1 = size * 0.5;
  const y0 = -size * 0.5;
  const y1 = size * 0.5;

  if (shape === "circular") {
    // Rounded/circular corner step: same controlling value as diagonal steps,
    // but the corner footprint is a quarter-circle instead of a triangle.
    const segments = 24;
    const points = [];
    if (pos === "right") {
      // Corner is the wall/right side intersection at (x0, y1).
      points.push(new THREE.Vector2(x0, y1));
      for (let i = 0; i <= segments; i += 1) {
        const a = (i / segments) * Math.PI * 0.5;
        points.push(new THREE.Vector2(x0 + Math.sin(a) * size, y1 - Math.cos(a) * size));
      }
    } else {
      // Corner is the wall/left side intersection at (x0, y0).
      points.push(new THREE.Vector2(x0, y0));
      for (let i = 0; i <= segments; i += 1) {
        const a = (i / segments) * Math.PI * 0.5;
        points.push(new THREE.Vector2(x0 + Math.cos(a) * size, y0 + Math.sin(a) * size));
      }
    }

    const roundedPath = new THREE.Shape(points);
    const roundedGeo = new THREE.ExtrudeGeometry(roundedPath, {
      depth: height,
      bevelEnabled: false,
      steps: 1
    });
    roundedGeo.translate(0, 0, -height * 0.5);
    roundedGeo.computeVertexNormals();
    roundedGeo.computeBoundingBox();
    return roundedGeo;
  }

  // Build a real triangular prism in local XY and extrude it through Z.
  // This avoids the previous hand-indexed faces, which could render as
  // dark/grey wall holes because some faces had poor winding/UVs.
  const points = pos === "right"
    ? [new THREE.Vector2(x0, y1), new THREE.Vector2(x1, y1), new THREE.Vector2(x0, y0)]
    : [new THREE.Vector2(x0, y0), new THREE.Vector2(x0, y1), new THREE.Vector2(x1, y0)];

  const shapePath = new THREE.Shape(points);
  const geo = new THREE.ExtrudeGeometry(shapePath, {
    depth: height,
    bevelEnabled: false,
    steps: 1
  });

  // ExtrudeGeometry runs from z=0..height. Centre it so existing step
  // positioning still treats the mesh origin as the middle of the solid block.
  geo.translate(0, 0, -height * 0.5);
  geo.computeVertexNormals();
  geo.computeBoundingBox();

  if (geo.attributes.uv && !geo.attributes.uv2) {
    geo.setAttribute("uv2", geo.attributes.uv.clone());
  }

  return geo;
}

function addStepBenchMeshes(group, params, layout, spanMinY, spanMaxY, startX, stepLength, topOffset, stepDepth) {
  // Disabled: the old side-bench add-on looked too busy with the new presets.
  // The second step now provides the full-width bench/ledge band.
  return;

  if (!params?.stepBenchEnabled || !group || !layout) return;

  const fullWidth = Math.max(0.05, spanMaxY - spanMinY);
  const stepMinY = layout.centerY - layout.width * 0.5;
  const stepMaxY = layout.centerY + layout.width * 0.5;
  const gap = 0.01;

  const ranges = [];
  const leftWidth = stepMinY - spanMinY;
  const rightWidth = spanMaxY - stepMaxY;

  if (leftWidth > 0.15) ranges.push([spanMinY, stepMinY - gap * 0.5]);
  if (rightWidth > 0.15) ranges.push([stepMaxY + gap * 0.5, spanMaxY]);

  // When the steps already occupy the full wall width there is no safe side bench
  // to add in this first-stage geometry. Leave it hidden instead of overlapping steps.
  if (!ranges.length || layout.width >= fullWidth - 0.02) return;

  const benchRun = Math.max(0.25, Math.min(0.6, stepLength * 1.5));
  const benchHeight = Math.max(0.05, Math.min(0.35, Number(stepDepth) || 0.2));
  const benchX = startX + benchRun * 0.5;
  const benchZ = -(topOffset + benchHeight * 0.5);

  ranges.forEach(([minY, maxY], idx) => {
    const benchWidth = Math.max(0.05, maxY - minY);
    const geo = new THREE.BoxGeometry(benchRun, benchWidth, benchHeight);
    const mat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa });
    const bench = new THREE.Mesh(geo, mat);

    bench.position.set(benchX, (minY + maxY) * 0.5, benchZ);
    bench.userData.isStep = true;
    bench.userData.isStepAddon = true;
    bench.userData.isStepBench = true;
    bench.userData.type = "step";
    bench.userData.stepIndex = -100 - idx;
    bench.userData.stepPosition = layout.position;
    bench.userData.stepWidth = benchWidth;
    bench.userData.baseHeight = benchHeight;
    bench.castShadow = true;
    bench.receiveShadow = true;

    group.add(bench);
  });
}


export function createLShapePool(params, tileSize = 0.3) {
  const {
    length,
    width,
    shallow,
    deep,
    shallowFlat,
    deepFlat,
    stepCount,
    stepDepth,
    stepWidth,
    stepPosition,
    stepShape
  } = params;

  const notchLengthX = Number.isFinite(params?.notchLengthX) ? params.notchLengthX : 0.4;
  const notchWidthY = Number.isFinite(params?.notchWidthY) ? params.notchWidthY : 0.45;

  const group = new THREE.Group();

  const clampedShallow = Math.max(0.5, shallow);
  const clampedDeep = Math.max(clampedShallow, deep);

  group.userData.poolParams = {
    length,
    width,
    shallow,
    deep,
    shallowFlat,
    deepFlat,
    stepCount,
    stepDepth,
    stepWidth,
    stepPosition,
    stepShape,
    notchLengthX,
    notchWidthY
  };

  // Live-preview source params used by previewUpdateDepths()
  group.userData.params = { ...group.userData.poolParams };

  /* -------------------------------------------------------
     OUTLINE (L-shape)
  ------------------------------------------------------- */
  const halfL = length / 2;
  const halfW = width / 2;

  const notchFracL = notchLengthX;
  const notchFracW = notchWidthY;

  const notchL = THREE.MathUtils.clamp(length * notchFracL, 0.6, Math.max(0.6, length - 0.6));
  const notchW = THREE.MathUtils.clamp(width * notchFracW, 0.6, Math.max(0.6, width - 0.6));

  const borderPts = [
    new THREE.Vector2(-halfL, -halfW),
    new THREE.Vector2(halfL, -halfW),
    new THREE.Vector2(halfL, halfW),
    new THREE.Vector2(halfL - notchL, halfW),
    new THREE.Vector2(halfL - notchL, halfW - notchW),
    new THREE.Vector2(-halfL, halfW - notchW)
  ];

  const shape = new THREE.Shape(borderPts);

  const STEP_LENGTH = 0.3;
  const STEP_TOP_OFFSET = 0.25;

  /* -------------------------------------------------------
     FLOOR  (BBOX-RECTANGLE PLANE)
  ------------------------------------------------------- */
  const bb2 = new THREE.Box2();
  for (const p of borderPts) bb2.expandByPoint(p);

  const wallMinX = bb2.min.x;
  const wallMaxX = bb2.max.x;
  const wallMinY = bb2.min.y;
  const wallMaxY = bb2.max.y;

  const bbLen = Math.max(0.01, wallMaxX - wallMinX);
  const bbWid = Math.max(0.01, wallMaxY - wallMinY);
  const cx = (wallMinX + wallMaxX) * 0.5;
  const cy = (wallMinY + wallMaxY) * 0.5;

  const segX = Math.max(2, Math.min(200, Math.ceil(bbLen / tileSize)));
  const segY = Math.max(2, Math.min(200, Math.ceil(bbWid / tileSize)));

  const floorGeo = new THREE.PlaneGeometry(bbLen, bbWid, segX, segY);
  const pos = floorGeo.attributes.position;

  let originX = wallMinX;
  if (stepCount > 0) originX = wallMinX + getStepFootprintLength(params, stepCount, STEP_LENGTH);

  const fullLen = wallMaxX - originX;

  let sFlat = shallowFlat || 0;
  let dFlat = deepFlat || 0;

  const maxFlats = Math.max(0, fullLen - 0.1);
  if (sFlat + dFlat > maxFlats) {
    const scale = maxFlats / (sFlat + dFlat);
    sFlat *= scale;
    dFlat *= scale;
  }

  const slopeLen = Math.max(0.01, fullLen - sFlat - dFlat);

  for (let i = 0; i < pos.count; i++) {
    const worldX = pos.getX(i) + cx;

    let dx = worldX - originX;
    if (dx < 0) dx = 0;

    let z;
    if (dx <= sFlat) {
      z = -clampedShallow;
    } else if (dx >= fullLen - dFlat) {
      z = -clampedDeep;
    } else {
      const t = (dx - sFlat) / slopeLen;
      z = -(clampedShallow + t * (clampedDeep - clampedShallow));
    }

    pos.setZ(i, z);
  }

  pos.needsUpdate = true;
  floorGeo.computeVertexNormals();

  const floor = new THREE.Mesh(
    floorGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  );
  floor.receiveShadow = true;
  floor.userData.isFloor = true;
  floor.userData.type = "floor";
  floor.position.set(cx, cy, 0);
  group.add(floor);

/* -------------------------------------------------------
     STEPS
  ------------------------------------------------------- */
  if (stepCount > 0) {
    const shallowDepth = clampedShallow;

    let stepSpanWidth = wallMaxY - wallMinY;
    if (!isFinite(stepSpanWidth) || stepSpanWidth < 0.05) stepSpanWidth = width * 0.6;
    const narrowLayout = getStepLayout(params, wallMinY, wallMaxY);
    const fullStepLayout = getStepLayout(params, wallMinY, wallMaxY, { fullWidth: true });

    for (let s = 0; s < stepCount; s++) {
      const layout = s === 1 ? fullStepLayout : narrowLayout;
      const topDepth = Math.max(0, Math.min(shallowDepth - 0.05, STEP_TOP_OFFSET + stepDepth * s));
      const h = Math.max(0.05, shallowDepth - topDepth);

      const bench2Extension = getBench2Extension(params);
      const diagonalStepSize = getDiagonalStepSize(params, bench2Extension);
      const isDiagonalNarrow = (params?.stepShape === "diagonal" || params?.stepShape === "circular") && s !== 1 && layout.position !== "center";
      const stepRun = isDiagonalNarrow ? diagonalStepSize : (s === 1 ? bench2Extension : STEP_LENGTH);
      const stepWidthForGeo = isDiagonalNarrow ? diagonalStepSize : layout.width;
      const geo = createStepGeometry(stepRun, stepWidthForGeo, h, params, layout);
      const mat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa });
      const step = new THREE.Mesh(geo, mat);

      const x = s === 0
        ? wallMinX + stepRun * 0.5
        : (s === 1
            ? wallMinX + stepRun * 0.5
            : wallMinX + bench2Extension + ((s - 2) * stepRun) + stepRun * 0.5);
      const z = -(topDepth + h * 0.5);

      step.position.set(x, layout.centerY, z);
      step.userData.isStep = true;
      step.userData.stepIndex = s;
      step.userData.stepPosition = layout.position;
      step.userData.stepShape = (params?.stepShape === "diagonal" || params?.stepShape === "circular") ? params.stepShape : "rectangle";
      step.userData.stepWidth = layout.width;
      step.userData.baseHeight = h;
      step.userData.stepRun = stepRun;

      step.castShadow = true;
      step.receiveShadow = true;
      group.add(step);
    }

    addStepBenchMeshes(
      group,
      params,
      narrowLayout,
      wallMinY,
      wallMaxY,
      wallMinX,
      STEP_LENGTH,
      STEP_TOP_OFFSET,
      stepDepth
    );
  }

  /* -------------------------------------------------------
     WATER
  ------------------------------------------------------- */
  const water = createPoolWater(length, width);
  const waterGeo = new THREE.ShapeGeometry(shape, 64);
  if (water.geometry) water.geometry.dispose();
  water.geometry = waterGeo;

  water.position.set(0, 0, -0.10);
  water.receiveShadow = true;
  if (water.material) water.material.depthWrite = false;
  water.renderOrder = 1;
  group.add(water);

  /* -------------------------------------------------------
     WALLS (200mm)
  ------------------------------------------------------- */
  const wallMeshes = [];
  const wallThickness = 0.2;

  for (let i = 0; i < borderPts.length; i++) {
    const wallGeo = createMiteredWallPrism(borderPts, i, wallThickness * 0.5, clampedDeep);
    if (!wallGeo) continue;

    generateMeterUVsForBoxGeometry(wallGeo, tileSize);

    const wall = new THREE.Mesh(
      wallGeo,
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide
      })
    );

    wall.position.z = -clampedDeep * 0.5;
    wall.castShadow = true;
    wall.receiveShadow = true;

    wall.userData.isWall = true;
    wall.userData.baseHeight = clampedDeep;
    wall.userData.currentHeight = clampedDeep;
    wall.userData.extraHeight = 0;
    wall.userData.edgeIndex = i;
    wall.userData.copingIndex = i;

    wallMeshes.push(wall);
    group.add(wall);
  }

  /* -------------------------------------------------------
     COPING SEGMENTS (one per wall, same linkage model as custom shapes)
  ------------------------------------------------------- */
  const pts2D = borderPts.map((p) => new THREE.Vector2(p.x, p.y));

  function polygonSignedArea(pts) {
    let a = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % n];
      a += p.x * q.y - q.x * p.y;
    }
    return a * 0.5;
  }

  const isCCW = polygonSignedArea(pts2D) > 0;
  const copingDepth = 0.05;
  const zOffset = 0.001;

  const copingTexLoader = new THREE.TextureLoader();
  const copingCol = copingTexLoader.load(new URL("../../textures/Coping/TilesTravertine001_COL_4K.jpg", import.meta.url).href);
  copingCol.wrapS = copingCol.wrapT = THREE.RepeatWrapping;
  copingCol.repeat.set(1.5, 1.5);

  function makeCopingMat() {
    return new THREE.MeshStandardMaterial({
      map: copingCol,
      color: 0xf1ece2,
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.DoubleSide
    });
  }

  const copingMeshes = [];
  for (let i = 0; i < pts2D.length; i++) {
    const count = pts2D.length;
    const pPrev = pts2D[(i - 1 + count) % count];
    const p0 = pts2D[i];
    const p1 = pts2D[(i + 1) % count];
    const pNext = pts2D[(i + 2) % count];
    const copingGeo = createMiteredWallPrism(pts2D, i, 0.125, copingDepth);
    if (!copingGeo) continue;
    generateMeterUVsForBoxGeometry(copingGeo, tileSize);

    copingGeo.computeVertexNormals();
    const copingMesh = new THREE.Mesh(copingGeo, makeCopingMat());
    copingMesh.castShadow = true;
    copingMesh.receiveShadow = true;
    copingMesh.position.z = copingDepth * 0.5 + zOffset;
    copingMesh.renderOrder = 3;
    copingMesh.userData.isCoping = true;
    copingMesh.userData.baseZ = copingMesh.position.z;
    copingMesh.userData.edgeIndex = i;
    group.add(copingMesh);
    copingMeshes.push(copingMesh);
  }
  group.userData.copingSegments = copingMeshes;

  /* -------------------------------------------------------
     METADATA / ANIMATION
  ------------------------------------------------------- */
  const animatables = [];
  if (water.userData && typeof water.userData.animate === "function") {
    animatables.push(water);
  }

  group.userData.animatables = animatables;
  group.userData.water = water;
  group.userData.waterMesh = water;
  group.userData.floorMesh = floor;
  group.userData.wallMeshes = wallMeshes;
  group.userData.wallThickness = wallThickness;
  group.userData.outerPts = borderPts;
  group.userData.spaSnapEdges = buildSpaSnapEdgesFromPoints(borderPts);

  if (water.userData && typeof water.userData.triggerRipple === "function") {
    group.userData.triggerRipple = water.userData.triggerRipple;
  }

  return group;
}
