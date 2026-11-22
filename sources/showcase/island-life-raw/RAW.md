# Island people and vehicles: raw Tripo3D outputs

These four files are the models as Tripo3D returned them. They are raw inputs to the engine's
`tools/samples/blender/island-life.py`, which finishes them into `showcase/island-life/life.glb`.
The engine does not name these files and does not load them: it loads the finished file.

## What made them

Each picture was made with `google/nano-banana-2.1` on fal.ai from the island brief, and each model
with Tripo3D image to model. The reference pictures live in the scene-references repository at
commit `18e8e33`, under `generated/island/`. Their prompts are in `prompts/` beside this file.

| Raw folder | Reference shot | Shot SHA-256 | fal request id | Tripo task id | Credits |
|---|---|---|---|---|---|
| `villager/` | `generated/island/villager-front.png` | `3b7051699f526ee5a63c4f540e93da5d61f8496b986d0e1614e356a9f371d5d4` | `01a200dd-edcb-70d2-a4e2-d37292c93713` | `33d0b431-b4c7-41d4-9735-c4b1d48b3415` | 30 |
| `hatchback/` | `generated/island/hatchback-front.png` | `e6a924897c7a1e43fd9500531bd800cb0c773b52ae2ca57b39e0ed9fa1bffd82` | `01a200de-2fcb-78e2-b150-5a883b179b6a` | `a31f3e57-1f42-4be9-8d9d-f8a6403d9e27` | 30 |
| `minibus/` | `generated/island/minibus-front.png` | `98cfc98580aa4ed1deb806609d6cb28043773e23dfee32286c03cfb4a81e3a7e` | `01a200de-6f29-7dd0-b426-f702b528a839` | `28093e96-b897-4eed-86f3-2ba3a68f5a1a` | 30 |
| `villager-walk/` | the villager above | same | same | `c05316a7-e62d-4b5b-ae74-6b9a913eaf71` | 10 |

`villager-walk/` is the villager's rigged model retargeted with an in-place `preset:walk` clip, with
geometry included. Its task records the rigged model as `0ce39537-7dd3-4704-b79d-c72c1e10fa64`.
The four tasks together used 100 credits.

## The files

- `model.glb` is the downloaded model, unchanged.
- `task.json` is the task as Tripo3D returned it, with the account's storage path in `input.file`
  replaced by a placeholder.
- `preview.webp` is Tripo3D's preview. Tripo3D serves it as a WebP picture.
- `villager-walk/` has no preview: that task returned no picture.

## Sizes in the raw files

Tripo3D wrote each model's real size into its root node's uniform scale: the villager stands 1.8 m,
the hatchback is 3.69 m long and the minibus 4.13 m long. The finished file sets the sizes the scene
asks for, 1.75 m, 3.7 m and 4.9 m, in Blender.
