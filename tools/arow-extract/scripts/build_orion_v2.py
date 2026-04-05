#!/usr/bin/env python3
"""Build Orion GLB using UnityPy's mesh.export() for correct vertex data,
combined with submesh info for multi-material support."""

import UnityPy
import struct, json, io, re
from PIL import Image

env = UnityPy.load("/tmp/arow-extract/WebBuildMar27.data")

# ── Collect all assets ──────────────────────────────────────────────
textures_by_id = {}
materials_by_id = {}
go_names = {}
mesh_filters = {}    # go_pid -> mesh path_id
mesh_renderers = {}  # go_pid -> [material_pids]
mesh_objects = {}    # path_id -> obj

for obj in env.objects:
    t = obj.type.name
    try:
        data = obj.read()
    except Exception:
        continue

    if t == "GameObject":
        go_names[obj.path_id] = data.m_Name
    elif t == "Texture2D":
        textures_by_id[obj.path_id] = obj
    elif t == "Mesh":
        mesh_objects[obj.path_id] = obj
    elif t == "Material":
        tex_refs = {}
        color = None
        if hasattr(data, "m_SavedProperties"):
            sp = data.m_SavedProperties
            if hasattr(sp, "m_TexEnvs"):
                for te in sp.m_TexEnvs:
                    ti = te[1]
                    if hasattr(ti, "m_Texture") and ti.m_Texture:
                        pid = getattr(ti.m_Texture, "path_id", 0)
                        if pid: tex_refs[te[0]] = pid
            if hasattr(sp, "m_Colors"):
                for ce in sp.m_Colors:
                    if ce[0] == "_Color":
                        c = ce[1]
                        if hasattr(c, "r"):
                            color = [round(c.r, 4), round(c.g, 4), round(c.b, 4), round(c.a, 4)]
        materials_by_id[obj.path_id] = {"name": data.m_Name, "textures": tex_refs, "color": color}
    elif t == "MeshFilter":
        go_pid = getattr(getattr(data, "m_GameObject", None), "path_id", 0)
        if hasattr(data, "m_Mesh") and data.m_Mesh:
            mesh_pid = getattr(data.m_Mesh, "path_id", 0)
            if go_pid and mesh_pid:
                mesh_filters[go_pid] = mesh_pid
    elif t == "MeshRenderer":
        go_pid = getattr(getattr(data, "m_GameObject", None), "path_id", 0)
        mat_ids = []
        if hasattr(data, "m_Materials"):
            for mref in data.m_Materials:
                pid = getattr(mref, "path_id", 0)
                mat_ids.append(pid)
        if go_pid: mesh_renderers[go_pid] = mat_ids

# ── Orion in-flight parts ───────────────────────────────────────────
orion_parts = {
    "UnifiedCMV2", "UnifiedCMV2_Face", "UnifiedSM.001",
    "Capsule", "Panel.001",
    "Thruster", "Thruster.002",
    "Cap", "Cap.001",
    "Cover", "Cover.001", "Cover.002", "Cover.003",
    "Fairing1_New", "Fairing2_New", "Fairing3_New",
    "Torus.001", "Torus.002", "Torus.003", "Torus.021",
    "Ring", "Ring.002",
    "Flag_&US_Alpha", "Meatball", "Worm", "Worm.002",
    "ESA_LOGO", "SMWormESADecal",
    "cable.007", "Cube.001", "Cube.003", "Cube.005",
    "Fins", "Fins.001",
    "Nozzles", "Nozzle",
    "RedParts_094", "RedParts_094.001",
    "UpperDecal", "UpperDecal.001", "UpperDecal.002", "UpperDecal.003",
    "Pipe", "Pipe2", "icosahedron",
    "pPlane1", "pCylinder1", "polySurface2", "pSphere1",
}

target_gos = {}
for go_pid, go_name in go_names.items():
    if go_name in orion_parts and go_pid in mesh_filters:
        target_gos[go_pid] = go_name

print(f"Found {len(target_gos)} Orion parts")


def parse_obj(obj_text):
    """Parse OBJ text into flat arrays."""
    positions = []
    normals = []
    uvs = []
    faces = []  # each face = list of (v_idx, vt_idx, vn_idx), 1-based

    for line in obj_text.split("\n"):
        parts = line.strip().split()
        if not parts:
            continue
        if parts[0] == "v" and len(parts) >= 4:
            positions.append((float(parts[1]), float(parts[2]), float(parts[3])))
        elif parts[0] == "vn" and len(parts) >= 4:
            normals.append((float(parts[1]), float(parts[2]), float(parts[3])))
        elif parts[0] == "vt" and len(parts) >= 3:
            uvs.append((float(parts[1]), float(parts[2])))
        elif parts[0] == "f":
            face_verts = []
            for fv in parts[1:]:
                indices = fv.split("/")
                vi = int(indices[0])
                vti = int(indices[1]) if len(indices) > 1 and indices[1] else 0
                vni = int(indices[2]) if len(indices) > 2 and indices[2] else 0
                face_verts.append((vi, vti, vni))
            faces.append(face_verts)

    return positions, normals, uvs, faces


def build_gltf_mesh_from_obj(obj_text, submeshes, mat_pids, builder):
    """Build glTF mesh primitives from OBJ text + submesh boundaries."""
    positions, normals, uvs, faces = parse_obj(obj_text)
    if not positions or not faces:
        return None

    # In the OBJ, vertices/normals/UVs are shared but face indices are
    # different per component. We need to "flatten" to per-vertex data
    # for glTF (which doesn't support separate index arrays for pos/norm/uv).

    # Create unique vertex combos and reindex
    unique_verts = {}
    flat_pos = []
    flat_norm = []
    flat_uv = []
    flat_indices = []

    for face in faces:
        for vi, vti, vni in face:
            key = (vi, vti, vni)
            if key not in unique_verts:
                idx = len(flat_pos) // 3
                unique_verts[key] = idx
                p = positions[vi - 1]
                flat_pos.extend(p)
                if normals and vni > 0:
                    n = normals[vni - 1]
                    flat_norm.extend(n)
                if uvs and vti > 0:
                    u, v = uvs[vti - 1]
                    flat_uv.extend([u, 1.0 - v])  # flip V for glTF
            flat_indices.append(unique_verts[key])

    return flat_pos, flat_norm, flat_uv, flat_indices


# ── glTF Builder ────────────────────────────────────────────────────
class GLTFBuilder:
    def __init__(self):
        self.buffer = bytearray()
        self.accessors = []
        self.buffer_views = []
        self.meshes = []
        self.nodes = []
        self.materials_list = []
        self.textures_gltf = []
        self.images = []
        self.mat_cache = {}
        self.tex_cache = {}

    def _align(self):
        while len(self.buffer) % 4:
            self.buffer.append(0)

    def add_buffer_view(self, data_bytes, target=None):
        self._align()
        offset = len(self.buffer)
        self.buffer.extend(data_bytes)
        bv = {"buffer": 0, "byteOffset": offset, "byteLength": len(data_bytes)}
        if target: bv["target"] = target
        idx = len(self.buffer_views)
        self.buffer_views.append(bv)
        return idx

    def add_accessor(self, bv_idx, comp_type, count, acc_type, min_val=None, max_val=None):
        acc = {"bufferView": bv_idx, "componentType": comp_type,
               "count": count, "type": acc_type}
        if min_val is not None: acc["min"] = min_val
        if max_val is not None: acc["max"] = max_val
        idx = len(self.accessors)
        self.accessors.append(acc)
        return idx

    def get_or_create_texture(self, tex_pid):
        if tex_pid in self.tex_cache:
            return self.tex_cache[tex_pid]
        tex_obj = textures_by_id.get(tex_pid)
        if not tex_obj:
            return -1
        try:
            tex_data = tex_obj.read()
            img = tex_data.image
            buf = io.BytesIO()
            max_dim = 1024
            if img.width > max_dim or img.height > max_dim:
                ratio = max_dim / max(img.width, img.height)
                img = img.resize((int(img.width * ratio), int(img.height * ratio)), Image.LANCZOS)
            if img.mode == "RGBA":
                img.save(buf, format="PNG", optimize=True)
            else:
                img = img.convert("RGB")
                img.save(buf, format="JPEG", quality=85)
        except Exception as e:
            print(f"    Warning: texture {tex_pid}: {e}")
            return -1

        png_bytes = buf.getvalue()
        self._align()
        bv_offset = len(self.buffer)
        self.buffer.extend(png_bytes)
        bv_idx = len(self.buffer_views)
        mime = "image/png" if png_bytes[:4] == b'\x89PNG' else "image/jpeg"
        self.buffer_views.append({"buffer": 0, "byteOffset": bv_offset,
                                  "byteLength": len(png_bytes)})
        img_idx = len(self.images)
        self.images.append({"bufferView": bv_idx, "mimeType": mime, "name": tex_data.m_Name})
        tex_idx = len(self.textures_gltf)
        self.textures_gltf.append({"source": img_idx})
        self.tex_cache[tex_pid] = tex_idx
        return tex_idx

    def get_or_create_material(self, mat_pid):
        if mat_pid in self.mat_cache:
            return self.mat_cache[mat_pid]
        mi = materials_by_id.get(mat_pid)
        if not mi:
            mat = {"name": f"unknown_{mat_pid}",
                   "pbrMetallicRoughness": {"baseColorFactor": [0.5, 0.5, 0.5, 1.0],
                                            "metallicFactor": 0.3, "roughnessFactor": 0.7}}
            idx = len(self.materials_list)
            self.materials_list.append(mat)
            self.mat_cache[mat_pid] = idx
            return idx

        mat = {"name": mi["name"], "pbrMetallicRoughness": {}}
        pbr = mat["pbrMetallicRoughness"]

        if mi["color"]:
            pbr["baseColorFactor"] = mi["color"]
        else:
            pbr["baseColorFactor"] = [0.7, 0.7, 0.7, 1.0]

        main_tex = mi["textures"].get("_MainTex", 0)
        if main_tex:
            tex_idx = self.get_or_create_texture(main_tex)
            if tex_idx >= 0:
                pbr["baseColorTexture"] = {"index": tex_idx}

        bump = mi["textures"].get("_BumpMap", 0)
        if bump:
            tex_idx = self.get_or_create_texture(bump)
            if tex_idx >= 0:
                mat["normalTexture"] = {"index": tex_idx}

        pbr["metallicFactor"] = 0.3
        pbr["roughnessFactor"] = 0.6

        if mi["name"] in ("Flag_&US_Alpha", "meatball", "Worm", "Worm.002",
                          "ESA_LOGO.001", "ESM_ESAWorm", "Logo_and_Flag"):
            mat["alphaMode"] = "BLEND"

        idx = len(self.materials_list)
        self.materials_list.append(mat)
        self.mat_cache[mat_pid] = idx
        return idx

    def add_mesh_node(self, name, flat_pos, flat_norm, flat_uv, submesh_face_ranges, mat_indices):
        """Add mesh with submesh support.
        flat_pos/norm/uv: flattened vertex data (all vertices).
        submesh_face_ranges: list of (start_face, count) in flat_indices terms.
        mat_indices: glTF material index per submesh.
        """
        vert_count = len(flat_pos) // 3
        if vert_count == 0:
            return

        # Position
        pos_bytes = struct.pack(f"<{len(flat_pos)}f", *flat_pos)
        pos_bv = self.add_buffer_view(pos_bytes, 34962)
        pos_min = [min(flat_pos[i::3]) for i in range(3)]
        pos_max = [max(flat_pos[i::3]) for i in range(3)]
        pos_acc = self.add_accessor(pos_bv, 5126, vert_count, "VEC3", pos_min, pos_max)

        norm_acc = None
        if flat_norm and len(flat_norm) == vert_count * 3:
            norm_bytes = struct.pack(f"<{len(flat_norm)}f", *flat_norm)
            norm_bv = self.add_buffer_view(norm_bytes, 34962)
            norm_acc = self.add_accessor(norm_bv, 5126, vert_count, "VEC3")

        uv_acc = None
        if flat_uv and len(flat_uv) == vert_count * 2:
            uv_bytes = struct.pack(f"<{len(flat_uv)}f", *flat_uv)
            uv_bv = self.add_buffer_view(uv_bytes, 34962)
            uv_acc = self.add_accessor(uv_bv, 5126, vert_count, "VEC2")

        primitives = []
        for si, (idx_start, idx_count) in enumerate(submesh_face_ranges):
            if idx_count == 0:
                continue
            sub_indices = submesh_face_ranges[si]  # it's passed as a list of index arrays
            # Actually, let me restructure...

        mesh_idx = len(self.meshes)
        self.meshes.append({"name": name, "primitives": primitives})
        node_idx = len(self.nodes)
        self.nodes.append({"name": name, "mesh": mesh_idx})

    def add_simple_mesh(self, name, flat_pos, flat_norm, flat_uv, index_groups, mat_gltf_indices):
        """index_groups: list of index arrays (one per submesh)."""
        vert_count = len(flat_pos) // 3
        if vert_count == 0:
            return

        pos_bytes = struct.pack(f"<{len(flat_pos)}f", *flat_pos)
        pos_bv = self.add_buffer_view(pos_bytes, 34962)
        pos_min = [min(flat_pos[i::3]) for i in range(3)]
        pos_max = [max(flat_pos[i::3]) for i in range(3)]
        pos_acc = self.add_accessor(pos_bv, 5126, vert_count, "VEC3", pos_min, pos_max)

        norm_acc = None
        if flat_norm and len(flat_norm) == vert_count * 3:
            norm_bytes = struct.pack(f"<{len(flat_norm)}f", *flat_norm)
            norm_bv = self.add_buffer_view(norm_bytes, 34962)
            norm_acc = self.add_accessor(norm_bv, 5126, vert_count, "VEC3")

        uv_acc = None
        if flat_uv and len(flat_uv) == vert_count * 2:
            uv_bytes = struct.pack(f"<{len(flat_uv)}f", *flat_uv)
            uv_bv = self.add_buffer_view(uv_bytes, 34962)
            uv_acc = self.add_accessor(uv_bv, 5126, vert_count, "VEC2")

        primitives = []
        for si, indices in enumerate(index_groups):
            if not indices:
                continue
            max_idx = max(indices)
            if max_idx > 65535:
                idx_bytes = struct.pack(f"<{len(indices)}I", *indices)
                comp = 5125
            else:
                idx_bytes = struct.pack(f"<{len(indices)}H", *indices)
                comp = 5123
            idx_bv = self.add_buffer_view(idx_bytes, 34963)
            idx_acc = self.add_accessor(idx_bv, comp, len(indices), "SCALAR")

            prim = {"attributes": {"POSITION": pos_acc}, "indices": idx_acc}
            if norm_acc is not None: prim["attributes"]["NORMAL"] = norm_acc
            if uv_acc is not None: prim["attributes"]["TEXCOORD_0"] = uv_acc
            if si < len(mat_gltf_indices) and mat_gltf_indices[si] >= 0:
                prim["material"] = mat_gltf_indices[si]
            primitives.append(prim)

        if not primitives:
            return

        mesh_idx = len(self.meshes)
        self.meshes.append({"name": name, "primitives": primitives})
        node_idx = len(self.nodes)
        self.nodes.append({"name": name, "mesh": mesh_idx})

    def build_glb(self, path):
        self._align()
        gltf = {
            "asset": {"version": "2.0", "generator": "artemis-extract-v2"},
            "scene": 0,
            "scenes": [{"nodes": list(range(len(self.nodes)))}],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "accessors": self.accessors,
            "bufferViews": self.buffer_views,
            "buffers": [{"byteLength": len(self.buffer)}],
            "materials": self.materials_list,
        }
        if self.textures_gltf: gltf["textures"] = self.textures_gltf
        if self.images: gltf["images"] = self.images

        json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
        while len(json_bytes) % 4: json_bytes += b" "
        total = 12 + 8 + len(json_bytes) + 8 + len(self.buffer)

        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, total))
            f.write(struct.pack("<II", len(json_bytes), 0x4E4F534A))
            f.write(json_bytes)
            f.write(struct.pack("<II", len(self.buffer), 0x004E4942))
            f.write(self.buffer)
        print(f"\nWrote {path} ({total / 1024 / 1024:.1f} MB)")


# ── Process each part ───────────────────────────────────────────────
builder = GLTFBuilder()

for go_pid, go_name in sorted(target_gos.items(), key=lambda x: x[1]):
    mesh_pid = mesh_filters.get(go_pid)
    if not mesh_pid or mesh_pid not in mesh_objects:
        continue

    mesh_obj = mesh_objects[mesh_pid]
    try:
        mesh_data = mesh_obj.read()
    except:
        print(f"  {go_name}: failed to read mesh")
        continue

    # Use export() for correct vertex data
    try:
        obj_text = mesh_data.export()
    except Exception as e:
        print(f"  {go_name}: export failed: {e}")
        continue

    if not obj_text or len(obj_text) < 10:
        print(f"  {go_name}: empty export")
        continue

    # Parse OBJ
    positions, normals, uvs, faces = parse_obj(obj_text)
    if not positions or not faces:
        print(f"  {go_name}: no geometry in OBJ")
        continue

    # Get submesh info
    submeshes = mesh_data.m_SubMeshes if hasattr(mesh_data, "m_SubMeshes") else []
    n_subs = len(submeshes)

    # Get material assignments
    mat_pids = mesh_renderers.get(go_pid, [])

    # Build flattened vertex buffer with unique vertex combos
    unique_verts = {}
    flat_pos = []
    flat_norm = []
    flat_uv = []
    has_normals = len(normals) > 0
    has_uvs = len(uvs) > 0

    # Flatten all faces into indices, tracking submesh boundaries
    # OBJ face ordering matches submesh ordering from Unity export
    all_flat_indices = []
    for face in faces:
        for vi, vti, vni in face:
            key = (vi, vti, vni)
            if key not in unique_verts:
                idx = len(flat_pos) // 3
                unique_verts[key] = idx
                flat_pos.extend(positions[vi - 1])
                if has_normals and vni > 0 and vni <= len(normals):
                    flat_norm.extend(normals[vni - 1])
                elif has_normals:
                    flat_norm.extend([0, 1, 0])
                if has_uvs and vti > 0 and vti <= len(uvs):
                    u, v = uvs[vti - 1]
                    flat_uv.extend([u, 1.0 - v])
                elif has_uvs:
                    flat_uv.extend([0, 0])
            all_flat_indices.append(unique_verts[key])

    # Split indices by submesh
    # Each submesh has indexCount triangles. The OBJ faces are in the same order.
    index_groups = []
    face_offset = 0
    for si, sm in enumerate(submeshes):
        n_faces = sm.indexCount // 3  # triangles
        n_indices = sm.indexCount
        # Each OBJ face is a triangle (3 vertices) → n_indices flat entries
        start = face_offset * 3  # 3 indices per face
        end = start + n_faces * 3
        sub_indices = all_flat_indices[start:end]
        index_groups.append(sub_indices)
        face_offset += n_faces

    # If no submeshes, use all indices as one group
    if not index_groups:
        index_groups = [all_flat_indices]

    # Create glTF materials for each submesh
    gltf_mats = []
    for i in range(max(len(index_groups), len(mat_pids))):
        if i < len(mat_pids) and mat_pids[i]:
            gltf_mats.append(builder.get_or_create_material(mat_pids[i]))
        else:
            gltf_mats.append(-1)

    total_verts = len(flat_pos) // 3
    print(f"  {go_name}: {total_verts} unique verts, {n_subs} submeshes, {len(mat_pids)} mats")
    for si, grp in enumerate(index_groups):
        mat_name = "???"
        if si < len(mat_pids):
            mi = materials_by_id.get(mat_pids[si])
            mat_name = mi["name"] if mi else "???"
        print(f"    sub[{si}]: {len(grp)} indices -> {mat_name}")

    builder.add_simple_mesh(go_name, flat_pos, flat_norm, flat_uv, index_groups, gltf_mats)

out_path = "/tmp/arow-extract/orion_v2.glb"
builder.build_glb(out_path)
