#!/usr/bin/env node
/**
 * Convert DualSense OBJ parts → single GLB file using Three.js (Node.js)
 *
 * Reads info.txt for per-part transforms, loads each OBJ, renames meshes
 * to match our controller-profiles.js naming convention, and exports
 * a combined GLB.
 *
 * Usage: node scripts/convert-dualsense.js [obj-dir] [output.glb]
 */

const fs = require('fs');
const path = require('path');

// Three.js core (CJS build)
const THREE = require('three');

// ── Minimal OBJ parser (Node.js — no DOM dependency) ──
function parseOBJ(text) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const vertexData = []; // { pos, norm, uv }
  const vertexMap = new Map();

  const lines = text.split('\n');
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'v') {
      positions.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
    } else if (parts[0] === 'vn') {
      normals.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
    } else if (parts[0] === 'vt') {
      uvs.push(parseFloat(parts[1]), parseFloat(parts[2]));
    } else if (parts[0] === 'f') {
      const faceVerts = [];
      for (let i = 1; i < parts.length; i++) {
        const key = parts[i];
        if (vertexMap.has(key)) {
          faceVerts.push(vertexMap.get(key));
        } else {
          const segs = key.split('/');
          const pi = (parseInt(segs[0]) - 1) * 3;
          const ti = segs[1] ? (parseInt(segs[1]) - 1) * 2 : -1;
          const ni = segs[2] ? (parseInt(segs[2]) - 1) * 3 : -1;

          const idx = vertexData.length;
          vertexData.push({
            px: positions[pi], py: positions[pi + 1], pz: positions[pi + 2],
            nx: ni >= 0 ? normals[ni] : 0, ny: ni >= 0 ? normals[ni + 1] : 0, nz: ni >= 0 ? normals[ni + 2] : 1,
            u: ti >= 0 ? uvs[ti] : 0, v: ti >= 0 ? uvs[ti + 1] : 0,
          });
          vertexMap.set(key, idx);
          faceVerts.push(idx);
        }
      }
      // Triangulate (fan)
      for (let i = 1; i < faceVerts.length - 1; i++) {
        indices.push(faceVerts[0], faceVerts[i], faceVerts[i + 1]);
      }
    }
  }

  const posArr = new Float32Array(vertexData.length * 3);
  const normArr = new Float32Array(vertexData.length * 3);
  const uvArr = new Float32Array(vertexData.length * 2);
  for (let i = 0; i < vertexData.length; i++) {
    const v = vertexData[i];
    posArr[i * 3] = v.px; posArr[i * 3 + 1] = v.py; posArr[i * 3 + 2] = v.pz;
    normArr[i * 3] = v.nx; normArr[i * 3 + 1] = v.ny; normArr[i * 3 + 2] = v.nz;
    uvArr[i * 2] = v.u; uvArr[i * 2 + 1] = v.v;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));

  if (normals.length === 0) geometry.computeVertexNormals();

  return geometry;
}

// ── Parse info.txt ──
function parseInfo(text) {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l);
  const parts = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].endsWith('.obj')) {
      const filename = lines[i];
      const values = [];
      for (let j = 1; j <= 16 && i + j < lines.length; j++) {
        values.push(parseFloat(lines[i + j]));
      }
      parts.push({
        filename,
        position: { x: values[0], y: values[1], z: values[2] },
        travel: { x: values[3], y: values[4], z: values[5] },
        popupOffset: { x: values[6], y: values[7], z: values[8] },
        popupRotation: { x: values[9], y: values[10], z: values[11] },
        triggerMax: values[12],
        stickMax: values[13],
        touchWidth: values[14],
        touchHeight: values[15],
      });
      i += 17;
    } else {
      i++;
    }
  }
  return parts;
}

// ── OBJ filename → our mesh naming convention ──
const NAME_MAP = {
  'a_button.obj':       'face_cross',       // Cross (PS) = A (Xbox layout in ref)
  'b_button.obj':       'face_circle',      // Circle = B
  'x_button.obj':       'face_square',      // Square = X
  'y_button.obj':       'face_triangle',    // Triangle = Y
  'left_bumper.obj':    'bumper_l1',
  'right_bumper.obj':   'bumper_r1',
  'left_trigger.obj':   'trigger_l2',
  'right_trigger.obj':  'trigger_r2',
  'back_button.obj':    'button_create',
  'start_button.obj':   'button_options',
  'guide_button.obj':   'button_ps',
  'left_stick.obj':     'stick_left_base',
  'right_stick.obj':    'stick_right_base',
  'left_cap.obj':       'stick_left',       // The cap is what tilts
  'right_cap.obj':      'stick_right',
  'left_ring.obj':      'stick_left_ring',
  'right_ring.obj':     'stick_right_ring',
  'dpad_up.obj':        'dpad_up',
  'dpad_down.obj':      'dpad_down',
  'dpad_left.obj':      'dpad_left',
  'dpad_right.obj':     'dpad_right',
  'top_shell.obj':      'body_top',
  'bottom_shell.obj':   'body_bottom',
  'extra.obj':          'body_extra',
  'touchpad.obj':       'touchpad',
  'touch_point1.obj':   'touch_point1',
  'touch_point2.obj':   'touch_point2',
};

// Material colors for DualSense parts
const MATERIAL_MAP = {
  body_top:         { color: 0xe8e8ec, roughness: 0.35, metalness: 0.05 },
  body_bottom:      { color: 0x1a1a1e, roughness: 0.4,  metalness: 0.05 },
  body_extra:       { color: 0x2a2a2e, roughness: 0.4,  metalness: 0.1 },
  face_cross:       { color: 0xe8e8ec, roughness: 0.3,  metalness: 0.0 },
  face_circle:      { color: 0xe8e8ec, roughness: 0.3,  metalness: 0.0 },
  face_square:      { color: 0xe8e8ec, roughness: 0.3,  metalness: 0.0 },
  face_triangle:    { color: 0xe8e8ec, roughness: 0.3,  metalness: 0.0 },
  bumper_l1:        { color: 0x1a1a1e, roughness: 0.4,  metalness: 0.1 },
  bumper_r1:        { color: 0x1a1a1e, roughness: 0.4,  metalness: 0.1 },
  trigger_l2:       { color: 0x1a1a1e, roughness: 0.45, metalness: 0.1 },
  trigger_r2:       { color: 0x1a1a1e, roughness: 0.45, metalness: 0.1 },
  button_create:    { color: 0x1a1a1e, roughness: 0.3,  metalness: 0.0 },
  button_options:   { color: 0x1a1a1e, roughness: 0.3,  metalness: 0.0 },
  button_ps:        { color: 0x1a1a1e, roughness: 0.3,  metalness: 0.2 },
  stick_left:       { color: 0x1a1a1e, roughness: 0.6,  metalness: 0.0 },
  stick_right:      { color: 0x1a1a1e, roughness: 0.6,  metalness: 0.0 },
  stick_left_base:  { color: 0x2a2a2e, roughness: 0.5,  metalness: 0.05 },
  stick_right_base: { color: 0x2a2a2e, roughness: 0.5,  metalness: 0.05 },
  stick_left_ring:  { color: 0x2a2a2e, roughness: 0.5,  metalness: 0.05 },
  stick_right_ring: { color: 0x2a2a2e, roughness: 0.5,  metalness: 0.05 },
  dpad_up:          { color: 0xe8e8ec, roughness: 0.35, metalness: 0.0 },
  dpad_down:        { color: 0xe8e8ec, roughness: 0.35, metalness: 0.0 },
  dpad_left:        { color: 0xe8e8ec, roughness: 0.35, metalness: 0.0 },
  dpad_right:       { color: 0xe8e8ec, roughness: 0.35, metalness: 0.0 },
  touchpad:         { color: 0xe8e8ec, roughness: 0.25, metalness: 0.05 },
  touch_point1:     { color: 0x4488ff, roughness: 0.3,  metalness: 0.0, emissive: 0x2244aa },
  touch_point2:     { color: 0x4488ff, roughness: 0.3,  metalness: 0.0, emissive: 0x2244aa },
};

// ── GLB writer (minimal binary glTF 2.0) ──
function exportGLB(scene) {
  // Collect all meshes
  const meshes = [];
  scene.traverse(child => {
    if (child.isMesh) meshes.push(child);
  });

  // Build buffers
  const accessors = [];
  const bufferViews = [];
  const gltfMeshes = [];
  const nodes = [];
  const materials = [];
  const materialMap = new Map();
  const bufferChunks = [];
  let byteOffset = 0;

  function addBufferView(data, target) {
    const arr = data instanceof Float32Array ? data :
                data instanceof Uint32Array ? data :
                data instanceof Uint16Array ? data : data;
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    // Pad to 4-byte alignment
    const padding = (4 - (bytes.length % 4)) % 4;
    const padded = new Uint8Array(bytes.length + padding);
    padded.set(bytes);

    const bv = {
      buffer: 0,
      byteOffset,
      byteLength: bytes.length,
    };
    if (target) bv.target = target;
    bufferViews.push(bv);
    bufferChunks.push(padded);
    byteOffset += padded.length;
    return bufferViews.length - 1;
  }

  function addAccessor(attribute, bvIndex, count, componentType, type, min, max) {
    const acc = { bufferView: bvIndex, byteOffset: 0, componentType, count, type };
    if (min) acc.min = min;
    if (max) acc.max = max;
    accessors.push(acc);
    return accessors.length - 1;
  }

  function getMaterialIndex(mesh) {
    const mat = mesh.material;
    const key = `${mat.color.getHex()}_${mat.roughness}_${mat.metalness}`;
    if (materialMap.has(key)) return materialMap.get(key);

    const gltfMat = {
      name: mesh.name + '_mat',
      pbrMetallicRoughness: {
        baseColorFactor: [mat.color.r, mat.color.g, mat.color.b, 1.0],
        metallicFactor: mat.metalness,
        roughnessFactor: mat.roughness,
      },
    };
    if (mat.emissive && mat.emissive.getHex() !== 0) {
      gltfMat.emissiveFactor = [mat.emissive.r, mat.emissive.g, mat.emissive.b];
    }
    const idx = materials.length;
    materials.push(gltfMat);
    materialMap.set(key, idx);
    return idx;
  }

  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const posAttr = geo.getAttribute('position');
    const normAttr = geo.getAttribute('normal');
    const indexAttr = geo.getIndex();

    // Apply mesh world transform to positions and normals
    mesh.updateMatrixWorld(true);
    const posData = new Float32Array(posAttr.count * 3);
    const normData = normAttr ? new Float32Array(normAttr.count * 3) : null;
    const pos = new THREE.Vector3();
    const norm = new THREE.Vector3();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);

    let minPos = [Infinity, Infinity, Infinity];
    let maxPos = [-Infinity, -Infinity, -Infinity];

    for (let i = 0; i < posAttr.count; i++) {
      pos.fromBufferAttribute(posAttr, i);
      pos.applyMatrix4(mesh.matrixWorld);
      posData[i * 3] = pos.x;
      posData[i * 3 + 1] = pos.y;
      posData[i * 3 + 2] = pos.z;
      minPos[0] = Math.min(minPos[0], pos.x);
      minPos[1] = Math.min(minPos[1], pos.y);
      minPos[2] = Math.min(minPos[2], pos.z);
      maxPos[0] = Math.max(maxPos[0], pos.x);
      maxPos[1] = Math.max(maxPos[1], pos.y);
      maxPos[2] = Math.max(maxPos[2], pos.z);

      if (normAttr) {
        norm.fromBufferAttribute(normAttr, i);
        norm.applyMatrix3(normalMatrix).normalize();
        normData[i * 3] = norm.x;
        normData[i * 3 + 1] = norm.y;
        normData[i * 3 + 2] = norm.z;
      }
    }

    // Position accessor
    const posBV = addBufferView(posData, 34962);
    const posAcc = addAccessor('POSITION', posBV, posAttr.count, 5126, 'VEC3', minPos, maxPos);

    const primitiveAttrs = { POSITION: posAcc };

    // Normal accessor
    if (normData) {
      const normBV = addBufferView(normData, 34962);
      const normAcc = addAccessor('NORMAL', normBV, normAttr.count, 5126, 'VEC3');
      primitiveAttrs.NORMAL = normAcc;
    }

    // Index accessor
    let indicesAcc;
    if (indexAttr) {
      const useUint32 = indexAttr.count > 65535 || posAttr.count > 65535;
      const indexData = useUint32
        ? new Uint32Array(indexAttr.array)
        : new Uint16Array(indexAttr.array);
      const indexBV = addBufferView(indexData, 34963);
      indicesAcc = addAccessor('INDEX', indexBV, indexAttr.count,
        useUint32 ? 5125 : 5123, 'SCALAR');
    }

    const matIdx = getMaterialIndex(mesh);

    const primitive = { attributes: primitiveAttrs, material: matIdx };
    if (indicesAcc !== undefined) primitive.indices = indicesAcc;

    const gltfMeshIdx = gltfMeshes.length;
    gltfMeshes.push({ name: mesh.name, primitives: [primitive] });

    // Node — identity transform (geometry already world-space, we'll reset in overlay)
    nodes.push({ name: mesh.name, mesh: gltfMeshIdx });
  }

  // Root node that contains all parts
  const rootChildren = nodes.map((_, i) => i);
  const rootIdx = nodes.length;
  nodes.push({ name: 'DualSense', children: rootChildren });

  // Assemble glTF JSON
  const gltf = {
    asset: { version: '2.0', generator: '3d-controller-overlay converter' },
    scene: 0,
    scenes: [{ name: 'DualSense', nodes: [rootIdx] }],
    nodes,
    meshes: gltfMeshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: byteOffset }],
  };

  const jsonStr = JSON.stringify(gltf);
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  // Pad JSON to 4-byte alignment
  const jsonPadding = (4 - (jsonBuf.length % 4)) % 4;
  const jsonPadded = Buffer.alloc(jsonBuf.length + jsonPadding, 0x20); // pad with spaces
  jsonBuf.copy(jsonPadded);

  // Combine binary chunks
  const binBuf = Buffer.concat(bufferChunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));

  // GLB header: magic (4) + version (4) + length (4) = 12 bytes
  // JSON chunk: length (4) + type (4) + data
  // BIN chunk:  length (4) + type (4) + data
  const totalLength = 12 + 8 + jsonPadded.length + 8 + binBuf.length;

  const glb = Buffer.alloc(totalLength);
  let offset = 0;

  // Header
  glb.writeUInt32LE(0x46546C67, offset); offset += 4; // 'glTF'
  glb.writeUInt32LE(2, offset); offset += 4;            // version
  glb.writeUInt32LE(totalLength, offset); offset += 4;

  // JSON chunk
  glb.writeUInt32LE(jsonPadded.length, offset); offset += 4;
  glb.writeUInt32LE(0x4E4F534A, offset); offset += 4; // 'JSON'
  jsonPadded.copy(glb, offset); offset += jsonPadded.length;

  // BIN chunk
  glb.writeUInt32LE(binBuf.length, offset); offset += 4;
  glb.writeUInt32LE(0x004E4942, offset); offset += 4; // 'BIN\0'
  binBuf.copy(glb, offset);

  return glb;
}

// ── Main ──
function main() {
  const objDir = process.argv[2] || '/tmp/dualsense-obj';
  const outputPath = process.argv[3] || path.join(__dirname, '..', 'src', 'assets', 'controllers', 'dualsense.glb');

  // Parse info.txt
  const infoPath = path.join(objDir, '..', 'dualsense_info.txt');
  let infoParts = [];
  const infoFile = fs.existsSync(infoPath) ? infoPath :
                   fs.existsSync(path.join(objDir, 'info.txt')) ? path.join(objDir, 'info.txt') : null;
  if (infoFile) {
    infoParts = parseInfo(fs.readFileSync(infoFile, 'utf8'));
    console.log(`Parsed info.txt: ${infoParts.length} parts`);
  }

  const scene = new THREE.Scene();
  let totalVerts = 0;
  let totalTris = 0;

  // Load and assemble each OBJ
  const objFiles = fs.readdirSync(objDir).filter(f => f.endsWith('.obj'));
  console.log(`Found ${objFiles.length} OBJ files`);

  for (const objFile of objFiles) {
    const meshName = NAME_MAP[objFile];
    if (!meshName) {
      console.log(`  Skipping unmapped: ${objFile}`);
      continue;
    }

    const objText = fs.readFileSync(path.join(objDir, objFile), 'utf8');
    const geometry = parseOBJ(objText);

    // Material
    const matDef = MATERIAL_MAP[meshName] || { color: 0x888888, roughness: 0.5, metalness: 0.1 };
    const material = new THREE.MeshStandardMaterial({
      color: matDef.color,
      roughness: matDef.roughness,
      metalness: matDef.metalness,
    });
    if (matDef.emissive) material.emissive = new THREE.Color(matDef.emissive);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = meshName;

    // Apply position from info.txt
    const info = infoParts.find(p => p.filename === objFile);
    if (info) {
      mesh.position.set(info.position.x, info.position.y, info.position.z);
    }

    scene.add(mesh);

    const posCount = geometry.getAttribute('position').count;
    const idxCount = geometry.getIndex()?.count || 0;
    totalVerts += posCount;
    totalTris += idxCount / 3;
    console.log(`  ${meshName} (${objFile}): ${posCount} verts, ${Math.floor(idxCount / 3)} tris`);
  }

  console.log(`\nTotal: ${totalVerts} vertices, ${Math.floor(totalTris)} triangles`);

  // Export GLB
  const glb = exportGLB(scene);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, glb);
  console.log(`\nExported: ${outputPath} (${(glb.length / 1024).toFixed(1)} KB)`);
}

main();
