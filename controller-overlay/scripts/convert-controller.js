#!/usr/bin/env node
/**
 * Generic OBJ → GLB converter for controller models.
 *
 * Reads OBJ files from a directory, maps filenames to mesh names using a
 * controller-specific profile, applies positions from info.txt, and exports
 * a single GLB file.
 *
 * Usage:
 *   node scripts/convert-controller.js <profile> [obj-dir] [output.glb]
 *
 * Profiles: dualsense, switch-pro, xbox
 *
 * Examples:
 *   node scripts/convert-controller.js switch-pro /tmp/models/Switch\ Pro
 *   node scripts/convert-controller.js xbox /tmp/models/Xbox\ One
 */

const fs = require('fs');
const path = require('path');
const THREE = require('three');

// ── Controller profiles: OBJ filename → mesh name, materials ──

const PROFILES = {
  'switch-pro': {
    rootName: 'SwitchPro',
    nameMap: {
      'a_button.obj':       'face_b',         // Switch B = right (maps to Gamepad btn 1)
      'b_button.obj':       'face_a',         // Switch A = bottom (maps to Gamepad btn 0)
      'x_button.obj':       'face_y',         // Switch Y = top
      'y_button.obj':       'face_x',         // Switch X = left
      'left_bumper.obj':    'bumper_l',
      'right_bumper.obj':   'bumper_r',
      'left_trigger.obj':   'trigger_zl',
      'right_trigger.obj':  'trigger_zr',
      'back_button.obj':    'button_minus',
      'start_button.obj':   'button_plus',
      'guide_button.obj':   'button_home',
      'misc.obj':           'button_capture',
      'left_stick.obj':     'stick_left_base',
      'right_stick.obj':    'stick_right_base',
      'left_cap.obj':       'stick_left',
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
    },
    materials: {
      body_top:           { color: 0x2d2d2d, roughness: 0.4,  metalness: 0.05 },
      body_bottom:        { color: 0x1a1a1a, roughness: 0.45, metalness: 0.05 },
      body_extra:         { color: 0x222222, roughness: 0.4,  metalness: 0.1 },
      face_a:             { color: 0x2d2d2d, roughness: 0.3,  metalness: 0.0 },
      face_b:             { color: 0x2d2d2d, roughness: 0.3,  metalness: 0.0 },
      face_x:             { color: 0x2d2d2d, roughness: 0.3,  metalness: 0.0 },
      face_y:             { color: 0x2d2d2d, roughness: 0.3,  metalness: 0.0 },
      bumper_l:           { color: 0x1a1a1a, roughness: 0.4,  metalness: 0.1 },
      bumper_r:           { color: 0x1a1a1a, roughness: 0.4,  metalness: 0.1 },
      trigger_zl:         { color: 0x1a1a1a, roughness: 0.45, metalness: 0.1 },
      trigger_zr:         { color: 0x1a1a1a, roughness: 0.45, metalness: 0.1 },
      button_minus:       { color: 0x1a1a1a, roughness: 0.3,  metalness: 0.0 },
      button_plus:        { color: 0x1a1a1a, roughness: 0.3,  metalness: 0.0 },
      button_home:        { color: 0x2d2d2d, roughness: 0.3,  metalness: 0.2 },
      button_capture:     { color: 0x1a1a1a, roughness: 0.3,  metalness: 0.0 },
      stick_left:         { color: 0x1a1a1a, roughness: 0.6,  metalness: 0.0 },
      stick_right:        { color: 0x1a1a1a, roughness: 0.6,  metalness: 0.0 },
      stick_left_base:    { color: 0x222222, roughness: 0.5,  metalness: 0.05 },
      stick_right_base:   { color: 0x222222, roughness: 0.5,  metalness: 0.05 },
      stick_left_ring:    { color: 0x222222, roughness: 0.5,  metalness: 0.05 },
      stick_right_ring:   { color: 0x222222, roughness: 0.5,  metalness: 0.05 },
      dpad_up:            { color: 0x2d2d2d, roughness: 0.35, metalness: 0.0 },
      dpad_down:          { color: 0x2d2d2d, roughness: 0.35, metalness: 0.0 },
      dpad_left:          { color: 0x2d2d2d, roughness: 0.35, metalness: 0.0 },
      dpad_right:         { color: 0x2d2d2d, roughness: 0.35, metalness: 0.0 },
    },
  },

  xbox: {
    rootName: 'Xbox',
    nameMap: {
      'a_button.obj':       'face_a',
      'b_button.obj':       'face_b',
      'x_button.obj':       'face_x',
      'y_button.obj':       'face_y',
      'left_bumper.obj':    'bumper_lb',
      'right_bumper.obj':   'bumper_rb',
      'left_trigger.obj':   'trigger_lt',
      'right_trigger.obj':  'trigger_rt',
      'back_button.obj':    'button_view',
      'start_button.obj':   'button_menu',
      'guide_button.obj':   'button_xbox',
      'left_stick.obj':     'stick_left_base',
      'right_stick.obj':    'stick_right_base',
      'left_cap.obj':       'stick_left',
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
    },
    materials: {
      body_top:           { color: 0xf0f0f0, roughness: 0.35, metalness: 0.05 },
      body_bottom:        { color: 0x1a1a1a, roughness: 0.4,  metalness: 0.05 },
      body_extra:         { color: 0x222222, roughness: 0.4,  metalness: 0.1 },
      face_a:             { color: 0x48c855, roughness: 0.3,  metalness: 0.0 },  // green
      face_b:             { color: 0xe84545, roughness: 0.3,  metalness: 0.0 },  // red
      face_x:             { color: 0x3b8beb, roughness: 0.3,  metalness: 0.0 },  // blue
      face_y:             { color: 0xf0c030, roughness: 0.3,  metalness: 0.0 },  // yellow
      bumper_lb:          { color: 0x1a1a1a, roughness: 0.4,  metalness: 0.1 },
      bumper_rb:          { color: 0x1a1a1a, roughness: 0.4,  metalness: 0.1 },
      trigger_lt:         { color: 0x1a1a1a, roughness: 0.45, metalness: 0.1 },
      trigger_rt:         { color: 0x1a1a1a, roughness: 0.45, metalness: 0.1 },
      button_view:        { color: 0x1a1a1a, roughness: 0.3,  metalness: 0.0 },
      button_menu:        { color: 0x1a1a1a, roughness: 0.3,  metalness: 0.0 },
      button_xbox:        { color: 0xf0f0f0, roughness: 0.2,  metalness: 0.3 },
      stick_left:         { color: 0x1a1a1a, roughness: 0.6,  metalness: 0.0 },
      stick_right:        { color: 0x1a1a1a, roughness: 0.6,  metalness: 0.0 },
      stick_left_base:    { color: 0x222222, roughness: 0.5,  metalness: 0.05 },
      stick_right_base:   { color: 0x222222, roughness: 0.5,  metalness: 0.05 },
      stick_left_ring:    { color: 0x222222, roughness: 0.5,  metalness: 0.05 },
      stick_right_ring:   { color: 0x222222, roughness: 0.5,  metalness: 0.05 },
      dpad_up:            { color: 0x1a1a1a, roughness: 0.35, metalness: 0.0 },
      dpad_down:          { color: 0x1a1a1a, roughness: 0.35, metalness: 0.0 },
      dpad_left:          { color: 0x1a1a1a, roughness: 0.35, metalness: 0.0 },
      dpad_right:         { color: 0x1a1a1a, roughness: 0.35, metalness: 0.0 },
    },
  },
};

// ── Minimal OBJ parser (same as convert-dualsense.js) ──
function parseOBJ(text) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const vertexData = [];
  const vertexMap = new Map();

  for (const line of text.split('\n')) {
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

// ── Parse info.txt (16 values per part) ──
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
      });
      i += 17;
    } else {
      i++;
    }
  }
  return parts;
}

// ── GLB exporter (same as convert-dualsense.js) ──
function exportGLB(scene, rootName) {
  const meshes = [];
  scene.traverse(child => { if (child.isMesh) meshes.push(child); });

  const accessors = [];
  const bufferViews = [];
  const gltfMeshes = [];
  const nodes = [];
  const materials = [];
  const materialMap = new Map();
  const bufferChunks = [];
  let byteOffset = 0;

  function addBufferView(data, target) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const padding = (4 - (bytes.length % 4)) % 4;
    const padded = new Uint8Array(bytes.length + padding);
    padded.set(bytes);
    const bv = { buffer: 0, byteOffset, byteLength: bytes.length };
    if (target) bv.target = target;
    bufferViews.push(bv);
    bufferChunks.push(padded);
    byteOffset += padded.length;
    return bufferViews.length - 1;
  }

  function addAccessor(bvIndex, count, componentType, type, min, max) {
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
      posData[i * 3] = pos.x; posData[i * 3 + 1] = pos.y; posData[i * 3 + 2] = pos.z;
      minPos[0] = Math.min(minPos[0], pos.x); minPos[1] = Math.min(minPos[1], pos.y); minPos[2] = Math.min(minPos[2], pos.z);
      maxPos[0] = Math.max(maxPos[0], pos.x); maxPos[1] = Math.max(maxPos[1], pos.y); maxPos[2] = Math.max(maxPos[2], pos.z);
      if (normAttr) {
        norm.fromBufferAttribute(normAttr, i);
        norm.applyMatrix3(normalMatrix).normalize();
        normData[i * 3] = norm.x; normData[i * 3 + 1] = norm.y; normData[i * 3 + 2] = norm.z;
      }
    }

    const posBV = addBufferView(posData, 34962);
    const posAcc = addAccessor(posBV, posAttr.count, 5126, 'VEC3', minPos, maxPos);
    const primitiveAttrs = { POSITION: posAcc };

    if (normData) {
      const normBV = addBufferView(normData, 34962);
      primitiveAttrs.NORMAL = addAccessor(normBV, normAttr.count, 5126, 'VEC3');
    }

    let indicesAcc;
    if (indexAttr) {
      const useUint32 = indexAttr.count > 65535 || posAttr.count > 65535;
      const indexData = useUint32 ? new Uint32Array(indexAttr.array) : new Uint16Array(indexAttr.array);
      const indexBV = addBufferView(indexData, 34963);
      indicesAcc = addAccessor(indexBV, indexAttr.count, useUint32 ? 5125 : 5123, 'SCALAR');
    }

    const primitive = { attributes: primitiveAttrs, material: getMaterialIndex(mesh) };
    if (indicesAcc !== undefined) primitive.indices = indicesAcc;

    gltfMeshes.push({ name: mesh.name, primitives: [primitive] });
    nodes.push({ name: mesh.name, mesh: gltfMeshes.length - 1 });
  }

  const rootIdx = nodes.length;
  nodes.push({ name: rootName, children: nodes.map((_, i) => i) });

  const gltf = {
    asset: { version: '2.0', generator: '3d-controller-overlay converter' },
    scene: 0,
    scenes: [{ name: rootName, nodes: [rootIdx] }],
    nodes, meshes: gltfMeshes, materials, accessors, bufferViews,
    buffers: [{ byteLength: byteOffset }],
  };

  const jsonStr = JSON.stringify(gltf);
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const jsonPadding = (4 - (jsonBuf.length % 4)) % 4;
  const jsonPadded = Buffer.alloc(jsonBuf.length + jsonPadding, 0x20);
  jsonBuf.copy(jsonPadded);

  const binBuf = Buffer.concat(bufferChunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  const totalLength = 12 + 8 + jsonPadded.length + 8 + binBuf.length;
  const glb = Buffer.alloc(totalLength);
  let offset = 0;

  glb.writeUInt32LE(0x46546C67, offset); offset += 4;
  glb.writeUInt32LE(2, offset); offset += 4;
  glb.writeUInt32LE(totalLength, offset); offset += 4;
  glb.writeUInt32LE(jsonPadded.length, offset); offset += 4;
  glb.writeUInt32LE(0x4E4F534A, offset); offset += 4;
  jsonPadded.copy(glb, offset); offset += jsonPadded.length;
  glb.writeUInt32LE(binBuf.length, offset); offset += 4;
  glb.writeUInt32LE(0x004E4942, offset); offset += 4;
  binBuf.copy(glb, offset);

  return glb;
}

// ── Main ──
function main() {
  const profileName = process.argv[2];
  if (!profileName || !PROFILES[profileName]) {
    console.error(`Usage: node convert-controller.js <${Object.keys(PROFILES).join('|')}> [obj-dir] [output.glb]`);
    process.exit(1);
  }

  const profile = PROFILES[profileName];
  const defaultDir = profileName === 'switch-pro' ? '/tmp/controller-models/source/models/Switch Pro'
                   : profileName === 'xbox' ? '/tmp/controller-models/source/models/Xbox One'
                   : `/tmp/controller-models/source/models/${profileName}`;
  const objDir = process.argv[3] || defaultDir;
  const outputPath = process.argv[4] || path.join(__dirname, '..', 'src', 'assets', 'controllers', `${profileName}.glb`);

  // Parse info.txt
  const infoPath = path.join(objDir, 'info.txt');
  let infoParts = [];
  if (fs.existsSync(infoPath)) {
    infoParts = parseInfo(fs.readFileSync(infoPath, 'utf8'));
    console.log(`Parsed info.txt: ${infoParts.length} parts`);
  }

  const scene = new THREE.Scene();
  let totalVerts = 0;
  let totalTris = 0;

  const objFiles = fs.readdirSync(objDir).filter(f => f.endsWith('.obj'));
  console.log(`Found ${objFiles.length} OBJ files in ${objDir}`);

  for (const objFile of objFiles) {
    const meshName = profile.nameMap[objFile];
    if (!meshName) {
      console.log(`  Skipping unmapped: ${objFile}`);
      continue;
    }

    const objText = fs.readFileSync(path.join(objDir, objFile), 'utf8');
    const geometry = parseOBJ(objText);

    // Skip empty geometry (placeholder OBJ files)
    const posCount = geometry.getAttribute('position').count;
    if (posCount === 0) {
      console.log(`  Skipping empty: ${objFile} (${meshName})`);
      continue;
    }

    const matDef = profile.materials[meshName] || { color: 0x888888, roughness: 0.5, metalness: 0.1 };
    const material = new THREE.MeshStandardMaterial({
      color: matDef.color,
      roughness: matDef.roughness,
      metalness: matDef.metalness,
    });
    if (matDef.emissive) material.emissive = new THREE.Color(matDef.emissive);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = meshName;

    const info = infoParts.find(p => p.filename === objFile);
    if (info) {
      mesh.position.set(info.position.x, info.position.y, info.position.z);
    }

    scene.add(mesh);

    const idxCount = geometry.getIndex()?.count || 0;
    totalVerts += posCount;
    totalTris += idxCount / 3;
    console.log(`  ${meshName} (${objFile}): ${posCount} verts, ${Math.floor(idxCount / 3)} tris`);
  }

  console.log(`\nTotal: ${totalVerts} vertices, ${Math.floor(totalTris)} triangles`);

  const glb = exportGLB(scene, profile.rootName);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, glb);
  console.log(`\nExported: ${outputPath} (${(glb.length / 1024).toFixed(1)} KB)`);
}

main();
