# cal-sync-icloud-google

把一个 iCloud 日历和一个 Google 日历做双向同步，跑在 Cloudflare Worker 上，每分钟执行一次。两边都走 CalDAV，同步状态存在 D1。正常情况下用免费版就够。

## 同步规则
- 同一条日程两边都改了，以 iCloud 为准，整条覆盖，不按字段合并。
- 一边删了、另一边改了，保留修改。
- 只同步日程（VEVENT），不同步提醒事项。写入对侧前会去掉 `ATTENDEE`、`ORGANIZER`、`METHOD`，所以不会给任何人发邀请。
- 重复日程按原始 ICS 整条复制，单次例外（`RECURRENCE-ID`）跟着一起走。
- 没有结束时间的日程，补上 `DTEND = DTSTART`，因为 iCloud 收到没有 DTEND 的日程会返回 404。

## 防误删
- 列表请求只要没返回 207 multistatus（比如 502、HTML 错误页、被跳转到登录页），本轮直接中止，不写任何东西。
- 只要以前同步过，任意一侧这次解析出 0 条日程，本轮中止，对端一条都不删。返回 207 但列表为空、或者只列出了非日程条目，都算这种情况。`ALLOW_MASS_DELETE` 也不能跳过这条检查。
  - 如果确实是你把某一侧清空了：先手动清空另一侧，再执行 `npx wrangler d1 execute cal-sync-icloud-google --remote --command "DELETE FROM items"` 重置同步状态。
- 单轮里某一侧要删的条数既超过 3 条、又超过总数的 30%，本轮中止。确认是你有意删的，就设 `ALLOW_MASS_DELETE=1` 重新部署一次，跑完再改回去。
- 列表里能看到、但读不到内容的条目，当作「状态未知」：这一侧本轮不删任何缺失的日程。
- 同一个日历里有重复的 UID：中止，需要先手动清理。
- 单条写入失败时，这一条的状态不更新，下一轮重试。遇到 429/503 立刻结束本轮。每个请求 30 秒超时。

## 工作原理
| 文件 | 作用 |
|---|---|
| `src/ics.ts` | 按行处理 ICS：取 UID、规范化后算 hash、写入对侧前清理内容 |
| `src/dav.ts` | 基于 `fetch` 的最小 CalDAV 客户端（PROPFIND、REPORT multiget、PUT、DELETE），以及 Google token 刷新 |
| `src/sync.ts` | 同步算法：`plan()` 是纯函数决策表，`sync()` 负责读取和执行 |
| `src/index.ts` | Worker 入口：定时触发、D1 存储、锁、ctag 快速跳过 |

算法参照 [vdirsyncer](https://github.com/pimutils/vdirsyncer)：每个 UID 存一行，两侧各存 `href`、`etag`、`hash`。判断某一侧「改过」的依据是规范化后的内容 hash 和**这一侧**上次记下的不同，算 hash 前会去掉 PRODID、DTSTAMP、VTIMEZONE 等服务器会自动改写的部分。这样服务器改写内容不会触发来回同步。我们写入对侧后，那一侧下一轮读回来的内容直接当作新基线。

每轮先比两边的 ctag，都没变就直接结束，只发 2 个请求。每轮最多写 `MAX_WRITES` 条（默认 20），这是为了不超过免费版每次 50 个子请求的限制，剩下的留到下一轮。

## 部署
需要 Node 22+。如果本机通过代理上网，下面运行 `node` 的命令前面都加上 `NODE_USE_ENV_PROXY=1`。

1. **iCloud**：在 appleid.apple.com 生成一个 App 专用密码。iCloud 没有开放 OAuth，只能用 Apple ID 加 App 专用密码。
2. **Google**：
   - 在 console.cloud.google.com 新建项目，启用 **CalDAV API**（不是 Calendar API）。
   - OAuth 同意屏幕的 Branding 页填好应用名、支持邮箱、首页和隐私政策链接（填个人主页即可）。**不要上传 logo**，上传会触发审核。
   - 到 Audience 页把应用发布为 **In production**。如果停在 Testing 状态，refresh token 7 天后就会失效。
   - 新建一个 **Desktop app** 类型的 OAuth Client。
3. `cp .dev.vars.example .dev.vars`，填入凭据。每行只写一个 `KEY=value`。然后获取 refresh token：
   ```bash
   set -a; . ./.dev.vars; set +a
   node scripts/discover.ts google-token
   ```
   在浏览器里完成授权后，浏览器会跳转到 `http://127.0.0.1:8765`。如果浏览器和脚本不在同一台机器上，这一步会打不开页面，这是正常的：把地址栏里的完整 URL 复制下来，执行 `node scripts/discover.ts google-token '<url>'`。拿到的 token 填进 `.dev.vars`。
4. 列出两边的日历地址，选好要同步的一对，填进 `.dev.vars` 的 `ICLOUD_CALENDAR_URL` 和 `GOOGLE_CALENDAR_URL`：
   ```bash
   node scripts/discover.ts calendars
   ```
   - 国区 iCloud 账号的地址是 `pXX-caldav.icloud.com.cn`，脚本会自动发现。
   - Google 的某个日历没列出来的话，先去 https://calendar.google.com/calendar/syncselect 把它勾上。
5. 创建 D1，把 `.dev.vars` 里的 7 个值都写成 Worker Secret，然后部署：
   ```bash
   npx wrangler login
   npx wrangler d1 create cal-sync-icloud-google     # 把输出的 database_id 填进 wrangler.jsonc
   npx wrangler d1 execute cal-sync-icloud-google --remote --file schema.sql
   npx wrangler secret bulk .dev.vars
   npm run deploy
   ```
6. 默认 `DRY_RUN=1`，只记录将要执行的动作，不实际写入。用 `npx wrangler tail` 看日志，确认没问题后，把 `wrangler.jsonc` 里的 `DRY_RUN` 改成 `"0"` 再部署一次。

建议先用两个空的 `sync-test` 日历跑通，再换成真正要同步的日历。换日历时要先清空 D1 的 `items` 表和 `meta` 表。

## 开发与测试
```bash
npm test             # 决策表、规范化、用 fake CalDAV 跑的端到端测试（含 502 和空列表保护）
npm run typecheck
set -a; . ./.dev.vars; set +a
node scripts/scenario.ts               # 对两个真实的 sync-test 日历跑完整场景，会写入数据，结束后清理
DRY_RUN=1 node scripts/local.ts        # 在本机跑一轮同步，状态存在 .local-state.json
```
`scripts/scenario.ts` 只有在两边日历都叫 `sync-test` 时才会运行。它在真实的 iCloud（国区）和 Google 上验证过这些场景：
- 普通日程、全天日程、带单次例外的重复日程、没有 DTEND 的日程的创建；
- 去掉参会人；
- 双向修改；
- 冲突时 iCloud 胜出；
- 在 Google 和 iCloud 上分别修改重复日程；
- 双向删除；
- 每一步同步完都会确认再跑一轮不会产生新的写入。

`wrangler dev` 自带一个 `/run` 调试入口，请求它会同步执行一轮并返回日志。部署后的 Worker 关掉了 `workers_dev`，没有公网 URL。如果本机需要通过代理上网，`wrangler dev` 启动的 workerd 连不上外网，这时请用 `scripts/*.ts` 调试，它们跑的是同一个 `sync()`。

## 已知限制
- 脚本刚写入某条日程后的一分钟内，如果你在同一侧又改了这一条，这次修改会被当作写入结果收下，要等你下次再改才会同步过去。见 `src/sync.ts` 里的 `ponytail:` 注释。
- vdirsyncer 报告过修改 Google 上的重复日程会返回 409（#963）。实测没有复现；万一遇到，只记日志，下一轮重试。
- 国区 iCloud 从 Cloudflare 访问是否稳定，还没有长期验证。
- 一个部署只同步一对日历。

## License
MIT
