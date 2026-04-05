#!/usr/bin/env python3
"""Extract Orion in-flight model from NASA AROW Unity data,
properly handling multiple submeshes and their material/texture assignments.
Produces a GLB with per-submesh materials."""

import UnityPy
import struct, json, io, os
from PIL import Image

env = UnityPy.load("/tmp/arow-extract/WebBuildMar27.data")

# ── Collect all assets ──────────────────────────────────────────────
textures_by_id = {}
materials_by_id = {}
go_names = {}
mesh_filters = {}    # go_pid -> mesh_obj
mesh_renderers = {}  # go_pid -> [material_pids]

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
                            color = [c.r, c.g, c.b, c.a]
        materials_by_id[obj.path_id] = {"name": data.m_Name, "textures": tex_refs, "color": color}
    elif t == "MeshFilter":
        go_pid = getattr(getattr(data, "m_GameObject", None), "path_id", 0)
        if hasattr(data, "m_Mesh") and data.m_Mesh:
            mesh_obj = data.m_Mesh
            if go_pid:
                mesh_filters[go_pid] = obj  # keep the MeshFilter object
    elif t == "MeshRenderer":
        go_pid = getattr(getattr(data, "m_GameObject", None), "path_id", 0)
        mat_ids = []
        if hasattr(data, "m_Materials"):
            for mref in data.m_Materials:
                pid = getattr(mref, "path_id", 0)
                mat_ids.append(pid)
        if go_pid: mesh_renderers[go_pid] = mat_ids

# ── Orion in-flight parts to include ────────────────────────────────
orion_parts = [
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
    "cable.007", "Cube.001", "Cube.003", "Cube.004", "Cube.005",
    "Fins", "Fins.001",
    "Nozzles", "Nozzle",
    "RedParts_094", "RedParts_094.001",
    "UpperDecal", "UpperDecal.001", "UpperDecal.002", "UpperDecal.003",
    "pPlane1", "Plane", "Cylinder",
    "pCylinder1", "polySurface2", "pSphere1",
    "Pipe", "Pipe2", "icosahedron",
]

# Match by exact GO name
target_gos = {}
for go_pid, go_name in go_names.items():
    if go_name in orion_parts and go_pid in mesh_filters:
        target_gos[go_pid] = go_name

print(f"Found {len(target_gos)} Orion parts to extract")

# ── Raw mesh extraction ─────────────────────────────────────────────
def read_mesh_raw(data):
    """Read raw vertex/index data from Unity mesh, handling compressed WebGL data."""
    name = data.m_Name

    # Get submesh info
    submeshes = []
    if hasattr(data, "m_SubMeshes"):
        for sm in data.m_SubMeshes:
            submeshes.append({
                "firstVertex": sm.firstVertex,
                "vertexCount": sm.vertexCount,
                "indexStart": sm.firstByte // 2 if hasattr(sm, "firstByte") else sm.indexStart,
                "indexCount": sm.indexCount,
                "topology": sm.topology,
            })

    # Vertex data
    vdata_raw = None
    if hasattr(data, "m_VertexData"):
        vd = data.m_VertexData
        if hasattr(vd, "m_DataSize") and vd.m_DataSize:
            vdata_raw = bytes(vd.m_DataSize)
        elif hasattr(vd, "data") and vd.data:
            vdata_raw = bytes(vd.data)

    # Index data
    idata_raw = None
    if hasattr(data, "m_IndexBuffer"):
        idata_raw = bytes(data.m_IndexBuffer)

    # Channel info
    channels = []
    vert_count = 0
    stride = 0
    if hasattr(data, "m_VertexData"):
        vd = data.m_VertexData
        vert_count = getattr(vd, "m_VertexCount", 0)
        if hasattr(vd, "m_Channels"):
            for ch in vd.m_Channels:
                channels.append({
                    "stream": ch.stream,
                    "offset": ch.offset,
                    "format": ch.format,
                    "dimension": ch.dimension & 0xF,
                })
        if hasattr(vd, "m_Streams") and vd.m_Streams:
            stride = vd.m_Streams[0].stride if hasattr(vd.m_Streams[0], "stride") else 0

    if not stride and channels:
        # Calculate stride from channels
        max_end = 0
        fmt_sizes = {0: 4, 1: 2, 2: 1, 3: 1, 4: 4, 5: 4, 11: 2, 12: 1}
        for ch in channels:
            if ch["stream"] == 0:
                fs = fmt_sizes.get(ch["format"], 4)
                end = ch["offset"] + ch["dimension"] * fs
                if end > max_end:
                    max_end = end
        stride = max_end

    return {
        "name": name,
        "vert_count": vert_count,
        "stride": stride,
        "channels": channels,
        "vdata": vdata_raw,
        "idata": idata_raw,
        "submeshes": submeshes,
    }


def parse_vertices(mesh_info):
    """Parse raw vertex buffer into positions, normals, UVs."""
    vdata = mesh_info["vdata"]
    stride = mesh_info["stride"]
    vert_count = mesh_info["vert_count"]
    channels = mesh_info["channels"]

    if not vdata or not stride or not vert_count:
        return None, None, None

    pos_ch = channels[0] if len(channels) > 0 else None  # position
    norm_ch = channels[1] if len(channels) > 1 else None  # normal
    uv_ch = channels[3] if len(channels) > 3 else None    # UV0

    positions = []
    normals = []
    uvs = []

    fmt_sizes = {0: 4, 1: 2, 2: 1, 3: 1, 4: 4, 5: 4, 11: 2, 12: 1}

    for i in range(vert_count):
        base = i * stride

        # Position (float32 x3)
        if pos_ch and pos_ch["dimension"] >= 3:
            off = base + pos_ch["offset"]
            px, py, pz = struct.unpack_from("<fff", vdata, off)
            positions.extend([px, py, pz])

        # Normal (float32 x3 or half x3)
        if norm_ch and norm_ch["dimension"] >= 3:
            off = base + norm_ch["offset"]
            if norm_ch["format"] == 0:  # float32
                nx, ny, nz = struct.unpack_from("<fff", vdata, off)
            else:
                nx, ny, nz = 0, 1, 0
            normals.extend([nx, ny, nz])

        # UV0
        if uv_ch and uv_ch["dimension"] >= 2:
            off = base + uv_ch["offset"]
            if uv_ch["format"] == 0:  # float32
                u, v = struct.unpack_from("<ff", vdata, off)
            elif uv_ch["format"] == 1:  # float16
                raw = struct.unpack_from("<HH", vdata, off)
                import numpy as np
                u = float(np.frombuffer(struct.pack("<H", raw[0]), dtype=np.float16)[0])
                v = float(np.frombuffer(struct.pack("<H", raw[1]), dtype=np.float16)[0])
            else:
                u, v = 0.0, 0.0
            uvs.extend([u, 1.0 - v])  # flip V for glTF

    return positions, normals, uvs


def parse_indices(mesh_info, submesh_idx):
    """Get triangle indices for a specific submesh."""
    idata = mesh_info["idata"]
    if not idata or submesh_idx >= len(mesh_info["submeshes"]):
        return None

    sm = mesh_info["submeshes"][submesh_idx]
    start = sm["indexStart"]
    count = sm["indexCount"]

    indices = []
    for j in range(count):
        off = (start + j) * 2
        if off + 2 <= len(idata):
            idx = struct.unpack_from("<H", idata, off)[0]
            indices.append(idx)
    return indices


# ── glTF builder ─────────────────────────────────────────────────────
class GLTFBuilder:
    def __init__(self):
        self.buffer = bytearray()
        self.accessors = []
        self.buffer_views = []
        self.meshes = []
        self.nodes = []
        self.materials = []
        self.textures_gltf = []
        self.images = []
        self.mat_cache = {}  # mat_name -> index
        self.tex_cache = {}  # tex_pid -> image index

    def add_buffer_view(self, data_bytes, target=None):
        # Align to 4 bytes
        while len(self.buffer) % 4: self.buffer.append(0)
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
        if min_val: acc["min"] = min_val
        if max_val: acc["max"] = max_val
        idx = len(self.accessors)
        self.accessors.append(acc)
        return idx

    def add_image(self, png_bytes, name="tex"):
        bv_idx = self.add_buffer_view(png_bytes)
        img = {"bufferView": bv_idx, "mimeType": "image/png", "name": name}
        idx = len(self.images)
        self.images.append(img)
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
            # Resize large textures for file size
            max_dim = 1024
            if img.width > max_dim or img.height > max_dim:
                ratio = max_dim / max(img.width, img.height)
                new_size = (int(img.width * ratio), int(img.height * ratio))
                img = img.resize(new_size, Image.LANCZOS)
            img.save(buf, format="PNG", optimize=True)
            png_bytes = buf.getvalue()
        except Exception as e:
            print(f"  Warning: could not read texture {tex_pid}: {e}")
            return -1

        img_idx = self.add_image(png_bytes, tex_data.m_Name)
        tex_idx = len(self.textures_gltf)
        self.textures_gltf.append({"source": img_idx, "name": tex_data.m_Name})
        self.tex_cache[tex_pid] = tex_idx
        return tex_idx

    def get_or_create_material(self, mat_pid):
        if mat_pid in self.mat_cache:
            return self.mat_cache[mat_pid]

        mi = materials_by_id.get(mat_pid)
        if not mi:
            # Default gray material
            mat = {"name": f"unknown_{mat_pid}",
                   "pbrMetallicRoughness": {"baseColorFactor": [0.5, 0.5, 0.5, 1.0],
                                            "metallicFactor": 0.3, "roughnessFactor": 0.7}}
            idx = len(self.materials)
            self.materials.append(mat)
            self.mat_cache[mat_pid] = idx
            return idx

        mat = {"name": mi["name"], "pbrMetallicRoughness": {}}
        pbr = mat["pbrMetallicRoughness"]

        # Color
        if mi["color"]:
            pbr["baseColorFactor"] = mi["color"]
        else:
            pbr["baseColorFactor"] = [0.7, 0.7, 0.7, 1.0]

        # Main texture
        main_tex_pid = mi["textures"].get("_MainTex", 0)
        if main_tex_pid:
            tex_idx = self.get_or_create_texture(main_tex_pid)
            if tex_idx >= 0:
                pbr["baseColorTexture"] = {"index": tex_idx}

        # Normal map
        bump_pid = mi["textures"].get("_BumpMap", 0)
        if bump_pid:
            tex_idx = self.get_or_create_texture(bump_pid)
            if tex_idx >= 0:
                mat["normalTexture"] = {"index": tex_idx}

        # Metallic
        metal_pid = mi["textures"].get("_MetallicGlossMap", 0)
        if metal_pid:
            tex_idx = self.get_or_create_texture(metal_pid)
            if tex_idx >= 0:
                pbr["metallicRoughnessTexture"] = {"index": tex_idx}

        pbr["metallicFactor"] = 0.3
        pbr["roughnessFactor"] = 0.6

        # Transparency for decals
        if mi["name"] in ("Flag_&US_Alpha", "meatball", "Worm", "Worm.002",
                          "ESA_LOGO.001", "ESM_ESAWorm", "Logo_and_Flag"):
            mat["alphaMode"] = "BLEND"

        idx = len(self.materials)
        self.materials.append(mat)
        self.mat_cache[mat_pid] = idx
        return idx

    def add_mesh(self, name, positions, normals, uvs, submesh_indices, mat_indices):
        """Add a mesh with multiple primitives (one per submesh)."""
        vert_count = len(positions) // 3

        # Position accessor
        pos_bytes = struct.pack(f"<{len(positions)}f", *positions)
        pos_bv = self.add_buffer_view(pos_bytes, target=34962)
        pos_min = [min(positions[i::3]) for i in range(3)]
        pos_max = [max(positions[i::3]) for i in range(3)]
        pos_acc = self.add_accessor(pos_bv, 5126, vert_count, "VEC3", pos_min, pos_max)

        # Normal accessor
        norm_acc = None
        if normals and len(normals) == vert_count * 3:
            norm_bytes = struct.pack(f"<{len(normals)}f", *normals)
            norm_bv = self.add_buffer_view(norm_bytes, target=34962)
            norm_acc = self.add_accessor(norm_bv, 5126, vert_count, "VEC3")

        # UV accessor
        uv_acc = None
        if uvs and len(uvs) == vert_count * 2:
            uv_bytes = struct.pack(f"<{len(uvs)}f", *uvs)
            uv_bv = self.add_buffer_view(uv_bytes, target=34962)
            uv_acc = self.add_accessor(uv_bv, 5126, vert_count, "VEC2")

        primitives = []
        for si, indices in enumerate(submesh_indices):
            if not indices:
                continue
            # Use 32-bit indices if any index > 65535
            max_idx = max(indices) if indices else 0
            if max_idx > 65535:
                idx_bytes = struct.pack(f"<{len(indices)}I", *indices)
                comp_type = 5125  # UNSIGNED_INT
            else:
                idx_bytes = struct.pack(f"<{len(indices)}H", *indices)
                comp_type = 5123  # UNSIGNED_SHORT

            idx_bv = self.add_buffer_view(idx_bytes, target=34963)
            idx_acc = self.add_accessor(idx_bv, comp_type, len(indices), "SCALAR")

            prim = {"attributes": {"POSITION": pos_acc}, "indices": idx_acc}
            if norm_acc is not None: prim["attributes"]["NORMAL"] = norm_acc
            if uv_acc is not None: prim["attributes"]["TEXCOORD_0"] = uv_acc

            if si < len(mat_indices) and mat_indices[si] >= 0:
                prim["material"] = mat_indices[si]

            primitives.append(prim)

        if not primitives:
            return -1

        mesh_idx = len(self.meshes)
        self.meshes.append({"name": name, "primitives": primitives})
        node_idx = len(self.nodes)
        self.nodes.append({"name": name, "mesh": mesh_idx})
        return node_idx

    def build_glb(self, path):
        # Pad buffer to 4 bytes
        while len(self.buffer) % 4: self.buffer.append(0)

        gltf = {
            "asset": {"version": "2.0", "generator": "artemis-extract"},
            "scene": 0,
            "scenes": [{"nodes": list(range(len(self.nodes)))}],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "accessors": self.accessors,
            "bufferViews": self.buffer_views,
            "buffers": [{"byteLength": len(self.buffer)}],
            "materials": self.materials,
        }
        if self.textures_gltf: gltf["textures"] = self.textures_gltf
        if self.images: gltf["images"] = self.images

        json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
        while len(json_bytes) % 4: json_bytes += b" "

        total = 12 + 8 + len(json_bytes) + 8 + len(self.buffer)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, total))  # glTF header
            f.write(struct.pack("<II", len(json_bytes), 0x4E4F534A))  # JSON chunk
            f.write(json_bytes)
            f.write(struct.pack("<II", len(self.buffer), 0x004E4942))  # BIN chunk
            f.write(self.buffer)

        print(f"\nWrote {path} ({total / 1024 / 1024:.1f} MB)")


# ── Main extraction ─────────────────────────────────────────────────
builder = GLTFBuilder()

# Build lookup: mesh_pid -> mesh object
mesh_objects = {}
for obj in env.objects:
    if obj.type.name == "Mesh":
        try:
            data = obj.read()
            mesh_objects[obj.path_id] = obj
        except:
            pass

# Process: for each MeshFilter, get the mesh object, read raw data,
# get MeshRenderer materials, and add to GLB
for go_pid, go_name in sorted(target_gos.items(), key=lambda x: x[1]):
    # Get the mesh from MeshFilter
    mf_obj = mesh_filters.get(go_pid)
    if not mf_obj:
        continue

    try:
        mf_data = mf_obj.read()
    except:
        continue

    mesh_ref = getattr(mf_data, "m_Mesh", None)
    if not mesh_ref:
        continue

    mesh_pid = getattr(mesh_ref, "path_id", 0)
    if not mesh_pid:
        continue

    # Read the mesh via its path_id
    mesh_obj_found = None
    for obj in env.objects:
        if obj.path_id == mesh_pid and obj.type.name == "Mesh":
            mesh_obj_found = obj
            break

    if not mesh_obj_found:
        print(f"  {go_name}: mesh not found (pid={mesh_pid})")
        continue

    mesh_data = mesh_obj_found.read()
    mesh_info = read_mesh_raw(mesh_data)

    if not mesh_info["vdata"] or not mesh_info["vert_count"]:
        print(f"  {go_name}: no vertex data (vert_count={mesh_info['vert_count']})")
        continue

    positions, normals, uvs = parse_vertices(mesh_info)
    if not positions:
        print(f"  {go_name}: failed to parse vertices")
        continue

    # Get material assignments from MeshRenderer
    mat_pids = mesh_renderers.get(go_pid, [])
    gltf_mat_indices = []
    for mat_pid in mat_pids:
        mat_idx = builder.get_or_create_material(mat_pid)
        gltf_mat_indices.append(mat_idx)

    # Parse indices for each submesh
    submesh_indices = []
    for si in range(len(mesh_info["submeshes"])):
        indices = parse_indices(mesh_info, si)
        submesh_indices.append(indices)

    n_subs = len(submesh_indices)
    n_mats = len(gltf_mat_indices)

    print(f"  {go_name}: {mesh_info['vert_count']} verts, {n_subs} submeshes, {n_mats} materials")
    for si, indices in enumerate(submesh_indices):
        mat_name = "???"
        if si < len(mat_pids):
            mi = materials_by_id.get(mat_pids[si])
            mat_name = mi["name"] if mi else "???"
        n_idx = len(indices) if indices else 0
        print(f"    sub[{si}]: {n_idx} indices -> {mat_name}")

    builder.add_mesh(go_name, positions, normals, uvs, submesh_indices, gltf_mat_indices)

out_path = "/tmp/arow-extract/orion_multi_mat.glb"
builder.build_glb(out_path)
