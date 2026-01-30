## Zomboid Control Panel v0.1.1-alpha

### Bug Fixes
- **Fixed:** 'Copy Mods=' and 'Copy WorkshopItems=' buttons not working (null-safety)
- **Fixed:** 'Mod Manager Error' when saving presets (workshopIds undefined)
- **Fixed:** 'Invalid server ID' error when editing servers (UUID support)
- **Fixed:** Server ID handling now works with both numeric and UUID-style IDs
- **Fixed:** RCON memory leak warning during rapid reconnection attempts

### Improvements
- Added RCON Host tooltip explaining to leave as 127.0.0.1 for local servers
- Mods page now auto-syncs from server on first load
- Added expandable WorkshopItems= and Mods= sections in Server Config tab
- Shows both workshop IDs and mod IDs with easy copy buttons

### Known Issues
- **B42 Beta:** Using `-cachedir` (separate data folder) breaks workshop mod loading in PZ B42 beta. This is a PZ bug, not a panel issue. Workaround: don't use `-cachedir` with B42 beta.
