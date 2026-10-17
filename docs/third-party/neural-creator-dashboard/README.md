# Neural Creator Dashboard attribution

Required Notice: Copyright (c) 2026 luoluo-121 and neural-creator-dashboard contributors

- Source: https://github.com/luoluo-121/neural-creator-dashboard
- Exact source commit: `769d690fa1c06d985926d8f16772d15514b718e1`
- Current upstream license: PolyForm Noncommercial 1.0.0. See the unmodified [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
- Upstream's earlier MIT exception is retained in the unmodified [MIT-legacy.txt](MIT-legacy.txt); this integration does not assume that exception covers the copied current-commit media or adapted code.
- Scope: the user's local, personal, noncommercial application. Commercial use of the current upstream materials requires the relevant rights holders' permission as described in the upstream notice.

## Copied media

The four original files are copied byte for byte from upstream `public/media/` to this application's `public/neural/`:

| File | Bytes |
| --- | ---: |
| `orb.mp4` | 8,334,089 |
| `orb.jpg` | 35,428 |
| `jellyfish.mp4` | 724,052 |
| `jellyfish.jpg` | 25,289 |

The upstream README identifies the orb and jellyfish videos as Dreamina (即梦) AI generated media. Upstream grants only rights its licensors hold; third party platform terms and rights remain applicable. No new ownership or exclusive rights are claimed here.

The license and notice are also copied to `public/neural/` so packaged frontend builds carry them alongside the media.

## Adapted code and composition

- `src/features/home/neural-media.tsx` adapts the `paintVideo` technique from upstream `src/neural/Home.jsx`: draw decoded video frames into a canvas, and use the original poster while loading. This addresses embedded browsers where video decoding works but direct video composition is invisible. Local adaptations add resize handling, a static image fallback, a 30 fps drawing cap, document visibility handling, explicit pause, and reduced motion support.
- `workspace-orbit.tsx` and `workspace-orbit.css` adapt the original's orb, colored jellyfish, neural threads, drifting motion and module expansion composition. Local CSS uses the application's existing theme tokens; in light mode media are inverted and blended using multiply, and dark mode uses screen.
- All task, file, category, active fence and knowledge inbox counts/content come from the application's existing stores/APIs. Upstream's example notes, graph data, graph analysis and fictional statistics are not copied. Secondary module links are drawn only for relationships derived from real application data, and content threads are limited to the number of real rows shown.

Original license files above are retained without modification. Local adaptations are identified in source comments.
