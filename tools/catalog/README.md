# Catalog generator

`generate.mjs` builds `apps/server/src/games/catalog.json`, the list of extra Steam games in the "New server" gallery.

It reads LinuxGSM's `lgsm/data/serverlist.csv` and each server's `_default.cfg` (`appid`, `port`, `queryport`),
asks SteamCMD (`app_info_print`, anonymous login) which of those apps have a Windows depot, drops Palworld and Valheim
(built in), and writes the result. Downloaded data is parsed, never executed.

Rerun (needs network access and a SteamCMD):

    node tools/catalog/generate.mjs <path-to-steamcmd.exe> [out.json]

`art.mjs` then adds each entry's `art`: the Steam header image of the game the server is for (dedicated-server apps
have no store art). It looks the game up with the Steam store search, accepting only an exact name match, with an
`OVERRIDES` table for the rest; it needs network access but no SteamCMD. Rerun it after `generate.mjs`:

    node tools/catalog/art.mjs [catalog.json]

Images are loaded by the viewer's browser straight from Steam's CDN; a card without art (or offline) falls back to the
game's initials.

These are developer tools: the server and its tests never run it or touch the network for the catalog.
Review the diff of `catalog.json` before committing it.

## Attribution

Game list and default ports come from [LinuxGSM](https://github.com/GameServerManagers/LinuxGSM) (MIT licence,
(c) Daniel Gibbs and contributors). Ports are defaults taken from the Linux configs; a game's real ports may differ.
