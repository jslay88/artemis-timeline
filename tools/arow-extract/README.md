# AROW Orion Model Extraction

Extracts the Orion MPCV 3D model from NASA's
[Artemis Real-time Orbit Website (AROW)](https://www.nasa.gov/missions/artemis-ii/arow/)
Unity WebGL build.

## Source Data

`source/WebBuildMar27.data` — Unity WebGL data bundle downloaded from:
```
https://www.nasa.gov/missions/artemis-ii/arow/Build/WebBuildMar27.data
```

## Directory Structure

```
scripts/          Python extraction & build scripts
source/           Raw Unity WebGL data bundle (~60 MB)
textures/         All textures extracted from the Unity bundle
meshes/           All meshes exported as OBJ from the Unity bundle
output/           Intermediate and final GLB/OBJ build artifacts
```

## Extraction Pipeline

### Prerequisites

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install UnityPy Pillow
```

### 1. Inspect the Unity bundle

```bash
python scripts/inspect_unity.py
```

Catalogs all assets (textures, meshes, materials, GameObjects) in the data bundle.

### 2. Trace mesh/material relationships

```bash
python scripts/trace_mesh_materials.py
```

Maps the Unity scene hierarchy: GameObjects → MeshFilters → MeshRenderers →
Materials → Textures, identifying which materials apply to which submeshes.

### 3. Build the GLB

```bash
python scripts/build_orion_v2.py
```

Builds a multi-material GLB from the Unity assets:
- Uses UnityPy's `mesh.export()` for reliable OBJ geometry (positions, normals, UVs)
- Reconstructs submesh index buffers from Unity's `m_SubMeshes` data
- Creates individual glTF materials for each Unity material reference
- Embeds textures (resized to 1024px max)
- Outputs `orion_v2.glb`

### 4. Fix UV coordinates

```bash
python scripts/fix_glb_uvs.py
```

Flips V coordinates (`v = 1.0 - v`) for all TEXCOORD_0 accessors.
Unity uses bottom-left UV origin; glTF uses top-left.

### 5. Inspect the final GLB

```bash
python scripts/inspect_glb.py
```

Dumps the GLB structure: meshes, primitives, materials, textures, images, nodes.

## Other Scripts

| Script | Purpose |
|--------|---------|
| `build_orion_glb.py` | First attempt at GLB build (raw vertex parsing — abandoned) |
| `debug_mesh.py` | Debug Unity mesh attributes |
| `debug_vdata.py` | Debug Unity vertex data layout |
| `trace2.py` / `trace3.py` | Additional scene hierarchy analysis |
| `verify_parse.py` | Verify OBJ parsing against Unity vertex counts |

## Notes

- The final production model is at `public/models/orion.glb`
- All NASA assets are public domain per NASA media usage guidelines
- The Unity bundle contains the full SLS stack (SRBs, core stage, ICPS, LAS, etc.)
  in addition to the in-flight Orion configuration used here
