// js/pool/shapes/rectanglePool.js
import * as THREE from "https://esm.sh/three@0.158.0";
import { createPoolWater } from "../water.js";

const STEP_PRESET_WIDTH = 0.9; // metres: preset left/centre/right step width
const DIAGONAL_STEP_MAX_SIZE = 0.6; // metres: diagonal corner steps stay equal and cannot exceed the bench run

function getStepLayout(params, spanMinY, spanMaxY, options = {}) {
  const fullWidth = Math.max(0.05, spanMaxY - spanMinY);
  const pos = params.stepPosition === "left" || params.stepPosition === "right" ? params.stepPosition : "center";

  // Preset behaviour:
  // - second step uses full pool width
  // - all other steps use a locked 900 mm width and align left/centre/right
  const configuredWidth = Number(params.stepWidth);
  const isDiagonal = params?.stepShape === "diagonal" && pos !== "center" && !options.fullWidth;
  const targetWidth = options.fullWidth
    ? fullWidth
    : (Number.isFinite(configuredWidth) && configuredWidth > 0 ? configuredWidth : STEP_PRESET_WIDTH);
  const maxNarrowWidth = isDiagonal ? Math.min(fullWidth, DIAGONAL_STEP_MAX_SIZE) : fullWidth;
  const width = Math.min(maxNarrowWidth, Math.max(0.05, targetWidth));

  let centerY = (spanMinY + spanMaxY) * 0.5;
  if (pos === "left") centerY = spanMinY + width * 0.5;
  if (pos === "right") centerY = spanMaxY - width * 0.5;
  return { width, centerY, position: pos, isFullWidth: !!options.fullWidth };
}

function createStepGeometry(runLength, stepWidth, height, params, layout) {
  const shape = params?.stepShape === "diagonal" ? "diagonal" : "rectangle";
  const pos = layout?.position === "right" ? "right" : layout?.position === "left" ? "left" : "center";

  // The full-width second step remains rectangular so it can keep acting as the
  // continuous wall-backed bench/ledge.
  const isFullWidthStep = layout?.isFullWidth === true;
  if (shape !== "diagonal" || isFullWidthStep || pos === "center") {
    return new THREE.BoxGeometry(runLength, stepWidth, height);
  }

  const x0 = -runLength * 0.5;
  const x1 = runLength * 0.5;
  const y0 = -stepWidth * 0.5;
  const y1 = stepWidth * 0.5;

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


export function createRectanglePool(params, tileSize = 0.3) {
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

  const group = new THREE.Group();
  const loader = new THREE.TextureLoader();

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
    stepShape
  };

  // Live-preview source params used by previewUpdateDepths()
  group.userData.params = { ...group.userData.poolParams };

  /* -------------------------------------------------------
     FLOOR
  ------------------------------------------------------- */
  const segmentsX = Math.max(2, Math.floor(length * 10));
  const segmentsY = Math.max(2, Math.floor(width * 10));
  const floorGeo = new THREE.PlaneGeometry(
    length,
    width,
    segmentsX,
    segmentsY
  );

  const pos = floorGeo.attributes.position;

  const axisStartWallX = -length / 2;
  const axisEndX = length / 2;

  const STEP_LENGTH = 0.3;
  const STEP_TOP_OFFSET = 0.25;

// Shared source of truth: how far the steps run into the pool
const stepFootprintLen = (stepCount > 0 ? STEP_LENGTH * stepCount : 0);

// Slope + flats begin AFTER the steps
const originX = axisStartWallX + stepFootprintLen;

// Persist for downstream systems / debugging
group.userData.stepFootprintLen = stepFootprintLen;
group.userData.originX = originX;

  const fullLen = axisEndX - originX;

  let sFlat = shallowFlat || 0;
  let dFlat = deepFlat || 0;

  const maxFlats = Math.max(0, fullLen - 0.01);
  if (sFlat + dFlat > maxFlats) {
    const scale = maxFlats / (sFlat + dFlat);
    sFlat *= scale;
    dFlat *= scale;
  }

  const slopeLen = Math.max(0.01, fullLen - sFlat - dFlat);

  for (let i = 0; i < pos.count; i++) {
    const worldX = pos.getX(i);
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

  floorGeo.computeVertexNormals();
  const floor = new THREE.Mesh(
    floorGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  );
  floor.receiveShadow = true;
  floor.userData.isFloor = true;
floor.userData.type = "floor";

  group.add(floor);

  /* -------------------------------------------------------
     STEPS
  ------------------------------------------------------- */
  if (stepCount > 0) {
    const shallowDepth = clampedShallow;
    const narrowLayout = getStepLayout(params, -width / 2, width / 2);
    const fullStepLayout = getStepLayout(params, -width / 2, width / 2, { fullWidth: true });

    for (let s = 0; s < stepCount; s++) {
      const layout = s === 1 ? fullStepLayout : narrowLayout;
      const topDepth = Math.max(0, Math.min(shallowDepth - 0.05, STEP_TOP_OFFSET + stepDepth * s));
      const h = Math.max(0.05, shallowDepth - topDepth);

      const stepRun = (params?.stepShape === "diagonal" && s !== 1 && layout.position !== "center") ? layout.width : (s === 1 ? STEP_LENGTH * 2 : STEP_LENGTH);
      const geo = createStepGeometry(stepRun, layout.width, h, params, layout);
      const mat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa });

      const step = new THREE.Mesh(geo, mat);

      const x = s === 1
        ? -length / 2 + stepRun * 0.5
        : -length / 2 + STEP_LENGTH * (s + 0.5);
      const z = -(topDepth + h * 0.5);

      step.position.set(x, layout.centerY, z);
      step.userData.isStep = true;
      step.userData.stepIndex = s;
      step.userData.stepPosition = layout.position;
      step.userData.stepShape = params?.stepShape === "diagonal" ? "diagonal" : "rectangle";
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
      -width / 2,
      width / 2,
      -length / 2,
      STEP_LENGTH,
      STEP_TOP_OFFSET,
      stepDepth
    );
  }

  /* -------------------------------------------------------
     WATER
  ------------------------------------------------------- */
  const waterGeo = floorGeo.clone();
  for (let i = 0; i < waterGeo.attributes.position.count; i++) {
    waterGeo.attributes.position.setZ(i, -0.1);
  }
  waterGeo.computeVertexNormals();

  const water = createPoolWater(length, width, waterGeo);
  water.receiveShadow = true;
  if (water.material) {
    water.material.depthWrite = false;
  }
  water.renderOrder = 1;
  group.add(water);

  /* -------------------------------------------------------
     WALLS
  ------------------------------------------------------- */
  const wallThickness = 0.2; // fixed wall thickness
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide
  });

  const walls = [
    new THREE.Mesh(
      new THREE.BoxGeometry(length, wallThickness, clampedDeep),
      wallMat.clone()
    ), // 0: south
    new THREE.Mesh(
      new THREE.BoxGeometry(length, wallThickness, clampedDeep),
      wallMat.clone()
    ), // 1: north
    new THREE.Mesh(
      new THREE.BoxGeometry(wallThickness, width, clampedDeep),
      wallMat.clone()
    ), // 2: east
    new THREE.Mesh(
      new THREE.BoxGeometry(wallThickness, width, clampedDeep),
      wallMat.clone()
    ) // 3: west
  ];

  // Top of walls is at z = 0 (center at -clampedDeep/2 with height clampedDeep)
  walls[0].position.set(0, -width / 2 - wallThickness / 2, -clampedDeep / 2); // south
  walls[1].position.set(0, width / 2 + wallThickness / 2, -clampedDeep / 2);  // north
  walls[2].position.set(length / 2 + wallThickness / 2, 0, -clampedDeep / 2); // east
  walls[3].position.set(-length / 2 - wallThickness / 2, 0, -clampedDeep / 2); // west

  const wallSides = ["south", "north", "east", "west"];
  const wallEdgeIndices = [0, 2, 1, 3];

  walls.forEach((w, idx) => {
    w.castShadow = true;
    w.receiveShadow = true;

    w.userData.isWall = true;
    w.userData.baseHeight = clampedDeep;
    w.userData.extraHeight = 0;
    w.userData.side = wallSides[idx];
    w.userData.copingKey = wallSides[idx];
    w.userData.edgeIndex = wallEdgeIndices[idx];

    group.add(w);
  });

  /* -------------------------------------------------------
     COPING – 4 SEPARATE SEGMENTS (one per wall)
     PBR Travertine from textures/Coping/
  ------------------------------------------------------- */
  const poolPts = [
    new THREE.Vector2(-length / 2, -width / 2),
    new THREE.Vector2(length / 2, -width / 2),
    new THREE.Vector2(length / 2, width / 2),
    new THREE.Vector2(-length / 2, width / 2)
  ];
  group.userData.outerPts = poolPts; // used by ground void etc.
  group.userData.spaSnapEdges = [
    {
      p0: poolPts[0].clone(),
      p1: poolPts[3].clone(),
      normal: new THREE.Vector2(1, 0)
    },
    {
      p0: poolPts[2].clone(),
      p1: poolPts[1].clone(),
      normal: new THREE.Vector2(-1, 0)
    },
    {
      p0: poolPts[1].clone(),
      p1: poolPts[0].clone(),
      normal: new THREE.Vector2(0, 1)
    },
    {
      p0: poolPts[3].clone(),
      p1: poolPts[2].clone(),
      normal: new THREE.Vector2(0, -1)
    }
  ];

  const copingOverhang = 0.05;  // inward overhang toward water
  const copingDepth = 0.05;     // vertical thickness of coping (match all pool shapes)
  const zOffset = 0.001;        // small lift to avoid z-fighting

  const halfL = length / 2;
  const halfW = width / 2;

  const outerHalfL = halfL + wallThickness;
  const outerHalfW = halfW + wallThickness;

  const longX = outerHalfL * 2;
  const longY = outerHalfW * 2;
  const short = wallThickness + copingOverhang;

  // PBR textures
  const baseColorMap = loader.load(
    "textures/Coping/TilesTravertine001_COL_4K.jpg"
  );
  const normalMap = loader.load(
    "textures/Coping/TilesTravertine001_NRM_4K.jpg"
  );
  const roughnessMap = loader.load(
    "textures/Coping/TilesTravertine001_GLOSS_4K.jpg"
  );
  const aoMap = loader.load(
    "textures/Coping/TilesTravertine001_AO_4K.jpg"
  );

  [baseColorMap, normalMap, roughnessMap, aoMap].forEach((tex) => {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 2);
  });

  function makeCopingMat() {
    return new THREE.MeshStandardMaterial({
      map: baseColorMap,
      normalMap,
      roughnessMap,
      aoMap,
      metalness: 0.0,
      roughness: 1.0
    });
  }

  function addUV2(geo) {
    if (geo.attributes && geo.attributes.uv && !geo.attributes.uv2) {
      geo.setAttribute(
        "uv2",
        new THREE.BufferAttribute(geo.attributes.uv.array, 2)
      );
    }
  }

  // SOUTH coping segment
  const copingSouthGeo = new THREE.BoxGeometry(longX, short, copingDepth);
  addUV2(copingSouthGeo);
  const copingSouth = new THREE.Mesh(copingSouthGeo, makeCopingMat());
  copingSouth.position.set(
    0,
    -halfW - wallThickness / 2 + copingOverhang / 2,
    copingDepth / 2 + zOffset
  );
  copingSouth.castShadow = true;
  copingSouth.receiveShadow = true;
  copingSouth.userData.isCoping = true;
  copingSouth.userData.baseZ = copingSouth.position.z;
  copingSouth.userData.side = "south";
  group.add(copingSouth);

  // NORTH coping segment
  const copingNorthGeo = new THREE.BoxGeometry(longX, short, copingDepth);
  addUV2(copingNorthGeo);
  const copingNorth = new THREE.Mesh(copingNorthGeo, makeCopingMat());
  copingNorth.position.set(
    0,
    halfW + wallThickness / 2 - copingOverhang / 2,
    copingDepth / 2 + zOffset
  );
  copingNorth.castShadow = true;
  copingNorth.receiveShadow = true;
  copingNorth.userData.isCoping = true;
  copingNorth.userData.baseZ = copingNorth.position.z;
  copingNorth.userData.side = "north";
  group.add(copingNorth);

  // EAST coping segment
  const copingEastGeo = new THREE.BoxGeometry(short, longY, copingDepth);
  addUV2(copingEastGeo);
  const copingEast = new THREE.Mesh(copingEastGeo, makeCopingMat());
  copingEast.position.set(
    halfL + wallThickness / 2 - copingOverhang / 2,
    0,
    copingDepth / 2 + zOffset
  );
  copingEast.castShadow = true;
  copingEast.receiveShadow = true;
  copingEast.userData.isCoping = true;
  copingEast.userData.baseZ = copingEast.position.z;
  copingEast.userData.side = "east";
  group.add(copingEast);

  // WEST coping segment
  const copingWestGeo = new THREE.BoxGeometry(short, longY, copingDepth);
  addUV2(copingWestGeo);
  const copingWest = new THREE.Mesh(copingWestGeo, makeCopingMat());
  copingWest.position.set(
    -halfL - wallThickness / 2 + copingOverhang / 2,
    0,
    copingDepth / 2 + zOffset
  );
  copingWest.castShadow = true;
  copingWest.receiveShadow = true;
  copingWest.userData.isCoping = true;
  copingWest.userData.baseZ = copingWest.position.z;
  copingWest.userData.side = "west";
  group.add(copingWest);

  group.userData.copingSegments = {
    south: copingSouth,
    north: copingNorth,
    east: copingEast,
    west: copingWest
  };

  /* -------------------------------------------------------
     METADATA / ANIMATION
  ------------------------------------------------------- */
  const animatables = [];
  group.traverse((o) => {
    if (o.userData && typeof o.userData.animate === "function") {
      animatables.push(o);
    }
  });

  group.userData.floorMesh = floor;
  group.userData.waterMesh = water;
  group.userData.water = water;
  group.userData.wallMeshes = walls;
  group.userData.wallThickness = wallThickness;
  group.userData.animatables = animatables;

  return group;
}
