# GITVerse interface system

This file records the visual and interaction rules already used by GITVerse. Treat the repository styles as the source of truth when this guidance and implementation differ. GITVerse is a desktop Git client for developers working across repositories, branches, diffs, and terminals.

## Visual direction

Use a quiet, dense developer workspace. Commit history and file changes carry the visual emphasis; application chrome should stay compact and predictable. Keep the existing Catppuccin inspired themes and blue interaction accent. Do not introduce the generated teal/orange palette, marketing-page patterns, decorative gradients, or new font downloads.

## Tokens

The canonical theme values live in `src/index.css` and Tailwind semantic mappings in `tailwind.config.cjs`.

| Role                       | Current token or value | Use                                            |
| -------------------------- | ---------------------- | ---------------------------------------------- |
| Main canvas                | `canvas`               | Page background                                |
| Raised surface             | `mantle`               | Panels and sidebar                             |
| Deep surface               | `crust`                | Inputs and toolbar                             |
| Border and control surface | `surface`              | Dividers, fields, hover states                 |
| Primary text               | `text`                 | Content and headings                           |
| Secondary text             | `sub`                  | Supporting labels; keep readable in all themes |
| Action and focus           | `#4cc2ff`              | Primary action, selection, keyboard focus      |
| AI accent                  | `#a855f7` family       | AI-only identity                               |
| Success                    | `#a6e3a1` family       | Successful Git operations                      |
| Warning                    | `#f9e2af` family       | Caution and detached HEAD                      |
| Destructive                | `#f38ba8` family       | Delete and irreversible actions                |

Themes are selected through `data-theme` on the document root. Add semantic theme tokens before introducing another repeated color; verify contrast separately for dark, midnight, graphite, and light themes.

## Type and density

Use the existing system stack beginning with Inter, with sans-serif body text. Keep repository names, hashes, paths, and code in the existing monospace treatments. The app is information-dense: use the established 4/8 px rhythm, compact rows, and clear separation between navigation, graph, and detail panes. Keep important controls at least 40 px high where practical and 44 px for primary touch-sized actions.

## Layout and behavior

- Preserve the desktop shell: repository tabs, operation toolbar, reference sidebar, commit graph, and contextual detail or working-change pane.
- Let panes resize and scroll independently; do not force the entire workspace to overflow horizontally at narrow window widths.
- Keep the active repository, branch, selected commit, and working-tree state visibly distinct. Never rely on color alone.
- Use progressive disclosure for advanced Git operations. Explain destructive effects in the confirmation step and keep action names consistent through completion feedback.
- Empty states should offer the next useful action. Loading and long-running scans must show progress and a usable cancel path.
- Use Lucide SVG icons consistently. Icon-only buttons need accessible names.

## Accessibility and motion

All controls must work with keyboard input and show `:focus-visible`. Maintain logical focus order and do not remove the browser outline without an equally visible replacement. Respect `prefers-reduced-motion`; keep motion tied to user actions. Provide labels, inline errors, and clear disabled/loading states.

## Review checklist

Check dark and light themes, keyboard-only use, long repository and branch names, empty and error states, and compact window widths. Verify that focus remains visible, labels remain understandable, and the graph remains the primary visual anchor. Avoid importing landing-page component patterns into the working application.
