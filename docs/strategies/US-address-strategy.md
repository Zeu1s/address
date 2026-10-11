# US 美国地址生成策略

| 项目 | 核心内容 |
|---|---|
| 主源 | Overture Maps addresses（全国分片 + 50 州与 DC 独立分片 `overture-usa-structures-<州>`）+ Geofabrik 美国 50 州、DC、Puerto Rico、US Virgin Islands 独立分片 |
| 既有门牌级格式 / 邮编 | `<house> <street>, <city>, <state> <ZIP>, US`；地址行使用源记录，不拼接虚构 Apt/Unit；源记录 ZIP/ZIP+4；仅接受 `\d{5}` 或 `\d{5}-\d{4}`，不自行推算 ZIP。只清洗格式，不创造或按邻近地址补齐 |
| 行政区 | Census TIGER/Line 与 Census Gazetteer 作为交叉核验候选；当前入库行政层级来自同步源字段与本地 catalog 反查。行政层级必须与坐标反查一致；冲突时保留源值在隔离区并拒绝发布 |
| 住宅子集证据 | OSM `building=house/apartments/...`、Overture buildings 明确住宅类别，或 FEMA/ORNL USA Structures 最近建筑（≤约 30 m）为 `OCC_CLS=Residential` 且 `PRIM_OCC` 为独栋、多户或活动房屋；没有证据只进隔离区，不进入住宅发布池。住宅证据必须来自明确建筑/用途字段，不能由地址存在推断 |
| 真实字段 / 生成字段 | 门牌、道路、城市、州代码、ZIP、可选单元和坐标均来自来源；生成字段：无，不拼接 Apt/Unit |
| 坐标 / 去重 | 来源坐标统一为 WGS84 并按美国本土及属地边界门禁；按来源 ID 和规范化地址 canonical hash 去重 |
| 发布门禁 | 接受真实街道级与已有门牌级地址；按实际精度检查来源、行政归属、语言和坐标。街道记录不强制门牌，不编造缺失字段；已有真实门牌保留，未知或歧义邮编留空；只有住宅子集要求独立住宅证据。 |
| 街道级格式 | `<street>, <city>, <state code>, US`；`matchLevel=street`，门牌、楼栋、室号为空；可唯一确定的来源邮编保留，否则留空。 |
| 街道去重 / 验证 | 国家 + 规范行政层级 + 街道名，同一路段不同坐标、邮编或来源 ID 不增加条数；行政字段不使用最近目录点推断。 |
| 同步方式 | 自动初始化一次；各州/地区来源独立保存状态。显式来源探测发现 Overture 或 Geofabrik 版本变化时才构建新快照 |
| 既有门牌来源验证 / 排除 | 行政区冲突、缺真实道路或坐标越界的记录淘汰；未知 ZIP 留空，地址节点名称不作为住宅楼名，普通真实门牌不强制住宅用途。 |
| 策略版本 / 状态 / 更新 | 1.11 / 分州 Overture + USA Structures 住宅佐证 + 容量扩展 / 2026-10-03 |

- 默认国家完成数量下限 50,000；州、县市、地区单来源均衡采样上限 2,000/300/80，后台可覆盖；国家总量不是发布上限，行政区划与邮编目录保持完整。


默认同步生命周期为自动初始化一次；未完成的额度或 checkpoint 任务自动续跑，完整扫描或来源耗尽后停止，不按日/月重复执行。只有来源、上游版本、严格提取能力变化或管理员明确刷新才重新运行；周期元数据探测仅在显式启用时执行。

统一证据等级、许可、配额与 VPS 边界见 [数据源与自动同步方案](../data-sources.md)。策略变化时同步更新本文件、实现与测试。

## 自动翻译恢复（2026-09-13）

- 原文恢复门禁修订 3（2026-09-13）：翻译恢复的基础资格仅检查原文的非住宅和自定义排除词，损坏的目标语言版本不阻断修复；发布前仍检查所有语言、地址事实和来源。仅旧基础契约拒绝按此能力版本重新评估一次，真实原文拒绝及未变化的供应商失败继续停止，不清空尝试、来源或额度状态。

- DeepL 仅使用 `api-free.deepl.com` 和 Free Key，不切换 Pro。每次先查账户额度，按 Unicode 码点原子预留字符；账户上限与所有启用 Key 的项目上限取最低值，共享持久账本，响应不明不退额度。用量查询可能延迟；外部应用用量不受本项目控制，Free 官方硬上限兜底。
- DeepL 默认项目上限为 500,000 字符，可在后台自定义，实际仍受账户额度约束；后台测试只查用量，不翻译。仅供应商可信周期可触发清零；没有周期日期时不按月初、重启或换 Key 重置。限速、鉴权和额度等待不等于地址来源耗尽。

- Google 使用免密钥网页接口，非 Cloud Translation 计费 API，可能限流或不可用；不承诺永久、无限免费。有道为可选付费降级，没有启用凭据时不调用；测试同样可能收费，项目限额不代表供应商免费额度。
- 每批最多发布一个国家，其他已翻译国家保留缓存并延期，不消耗失败次数。同一发布事务内仅对本批变更地址执行完整来源、地址和语言门禁，再从已验证索引重排全国连续序号并刷新计数；未变更地址不重复扫描来源证据。全量来源导入仍执行完整重建，门禁不降低。
- 批次默认 180 秒硬超时；超时或取消仍持久化收尾进度，已提交国家不回退。派发前中断、429/额度等待、短锁竞争和跨国延期不扣失败次数；已派发但响应丢失保守计次。真实请求失败、发布语句超时或事务冲突按指数退避，记录最多 3 次；达到上限后须地址输入或服务配置变化才重评，不清空历史失败。
- 生产同步初始化保留真实 readiness；启动健康检查宽限 3 分钟，成功后继续每 15 秒检查、单次 5 秒超时及 8 次失败上限，不提前报就绪。

- 复用后台翻译配置；有效缓存优先，在线路由按管理员定义的优先级数值从小到大执行，同优先级轮询，并跳过不可用、冷却中、额度耗尽或失败的路由；新建 OpenAI 兼容路由默认排在 DeepL、有道和 Google 之前。所有 DeepL 入口必须通过 Credential Broker。`TRANSLATION_BACKFILL_YOUDAO_DAILY_CHARACTERS` 每日最多 10,000 字符，不代表实际费用或账户额度。
- 优先街道，再处理其他非中国地址；仅恢复当前授权来源有效、基础契约合格且因 `publication-validation:` 退役的记录。只翻译语义字段，保留原文、门牌、单元、邮编、坐标和来源时间，组件与整行地址同步写回。
- 进度、输入版本和有限重试持久化到 PostgreSQL；同步繁忙时仍以独立连接池运行，发布锁竞争时退避。完整校验通过后在同一事务恢复地址、生成索引及统计；失败或来源撤销的记录保持未发布，不重置来源队列、checkpoint 或耗尽状态。

## 覆盖与保留

- 覆盖映射修订 3（2026-09-13）：按真实目录 ID 区分同名节点，名称不是唯一身份；明确省区之外的同名城市不得覆盖原归属，不按人口或最近坐标猜测。先匹配完整名称和代码，再使用该国家的行政词缀与简繁等价形式，歧义保留未映射；台湾县、市由目录类型区分。后台下钻保留零地址城市和真实层级，不影响生成筛选隐藏零项。
- 翻译配置恢复修订 2（2026-09-13）：服务配置真正变化后，终态记录由有界待评估查询自动重评，不等待全池游标绕回；已经合法发布的记录校验通过后仅纠正陈旧恢复状态，保留尝试次数且不重发供应商请求。同一输入的真实终态仍停止，基础契约拒绝、来源耗尽和配额账本不被清零。

- 独立刷新区域统计时，先在事务内按发布相同顺序锁定地址、证据、索引和统计表，再读取及发布结果，避免并发回填被旧统计覆盖；官方目录的零地址节点保留。

- 官方行政区目录定义覆盖分母；关联到官方节点的合格街道及门牌地址计入分子，住宅子集单独统计。
- 每个有合格数据的最低行政区先满足每节点、省市和单节点目标，再轮询分配额外记录；国家总量是完成下限，节点规则可推动总量继续增长，来源或分片容量仍是技术硬限制。
- 每次国家快照发布后自动重建总地址覆盖和住宅子集覆盖；无合格数据的区域显示零覆盖，不能作为可生成选项。
- 同步进程启动时仅修复发布池、索引、后台和同步计数有差异的派生统计；不重抓来源、不重置验证断点或解除耗尽/额度等待。


## 运行时随机生成

- 语言门禁一致性（2026-09-08）：发布统计、生成索引和候选 SQL 与读取层共享中英文语义字段的脚本规则，逐项检查街道、楼名和行政名称，排除混入目标语言不允许文字的记录；中文仍须含汉字。门牌、单元和邮编标识不参加此脚本检查；原文、来源能力版本和额度不变，待翻译记录不得计入可发布数量。

- 公开普通生成直接在 PostgreSQL 完整合格范围选择：支持连续生成序号的未筛选国家池按序号等概率选择，筛选范围使用有界循环索引窗口；不使用固定子集或固定顺序。
- 每次按 seed 在有界候选窗口内执行独立偏移，再按主键读取完整地址与证据；API 不把完整地址池加载到进程内存，也不执行全表随机排序。
- 未传入 seed 时由服务器为每个请求生成新 UUID；相同显式 seed 在同一数据库快照中可复现。数据库提交后，新 worker 快照全部就绪才原子替换旧快照。

## 既有来源街道提取（2026-09-08）

- Geofabrik `g70-streets` 提取来源命名道路及已有门牌，保留真实行政字段；道路点位于原始线几何，按国家/行政层/道路去重，不从最近目录点补行政区。街道邮编、楼栋、单元和住宅证据为空；非住宅门牌保留但不获得住宅用途。
- Overture `addresses-streets-residential-subset-v6` 保留来源街道和未匹配住宅建筑的真实门牌；仅实际相交且有明确住宅类别的门牌获得住宅证据，街道不得因落入建筑面而获得住宅用途。候选先去重再均衡采样；建筑分类失败保留地址事实，不伪造住宅证据。

## 生成筛选与管理边界（2026-09-13）

- 生成和快捷选择仅展示经过完整发布门禁的生成索引中有可用地址的选项，零项在分页前排除；管理覆盖树与完成判定仍保留完整官方目录的零地址节点。
- 城市、行政区名称/代码/ID 与生成使用同一条件；层级边界兼容路径尾斜杠，精确筛选不依赖目录中心坐标。共用邮编不隐式限定代表城市；按发布版本失效缓存，不重复扫描原始证据。真实地址坐标、来源、语言和住宅证据门禁不降低。
- 完整邮编筛选（2026-09-13，运行时筛选修订 2）：以生成索引中的真实完整码为准，目录仅补充已存在的标签与 ID；目录只含前缀或缺项时仍可按完整码选择，不制造目录 ID 或行政归属。文本码精确校验发布索引与所选省市，未知、前缀或退役码不匹配；空格/大小写规范化，原有 ID 兼容，翻译与来源指纹不变。

## Shared translation recovery revision 4 (2026-09-13)

- Cached API translations preserve postal, house, unit and administrative identifiers and semantic-field numbers. Equivalent decimal scripts and explicit CJK address ordinals are compared by value; changed digits and leading zeros are rejected.
- Canonical administrative translations require a unique catalog identity within the verified region, never a population-based same-name guess. Native source facts and source execution fingerprints are unchanged.
- Non-China recovery checks cached/canonical fields before bounded provider requests. Failed translations receive a paged cache-only reevaluation; unchanged publication failures retain their retry limit. Recovery diagnostics reuse source/publication predicates and store reason, language and field only, not addresses or credentials.
- When a provider alters a numeric or alphanumeric street/building token, recovery translates only the text spans and restores the source identifiers; all language, numeric, identifier, use-evidence and blacklist gates still apply. Provider cooldowns cannot trigger another dispatch to that provider in the same batch. Priority remains cache first, then enabled routes in administrator-defined ascending priority with round-robin among ties; unavailable, cooling-down, quota-exhausted and failed routes are skipped. New OpenAI-compatible routes default ahead of DeepL, Youdao and Google; character reservations and source-exhaustion states are not reset.

## Shared publication/index consistency revision 5 (2026-09-18)

- The generation index is a candidate accelerator, not publication authority. Every selected row is revalidated against current quality, expiry, country, residential evidence and requested administrative/postcode/search filters before return; stale rows are skipped. Startup consistency compares current source IDs with active index IDs, so equal counts with different membership trigger repair.
- Published coverage is calculated from the freshly rebuilt active generation index; `residential_count` uses current evidence-backed `residential_ready`, and all grouped counts use distinct address IDs. Date-only expiry remains valid through the end of that UTC date. Shared GET generation text and ID inputs are bounded and reject control characters without relaxing country-specific source, language, coordinate or evidence gates.


## Translation recovery and provider compatibility revision 6 (2026-09-19)

- Recoverable source records remain stored when translation is unavailable. Discovery, due retries and cache-only reevaluation take bounded turns, so repeatedly cooling providers cannot monopolize recovery. Unchanged deterministic failures retain finite retries; effective provider configuration changes permit reevaluation without resetting source exhaustion or quota ledgers.
- Elapsed credential cooldowns become executable automatically; the broker still enforces live quotas. Repaired non-China records pass the full contract before transactional publication, index and count updates. China retains its existing residential contract.
- Model discovery preserves advertised endpoint and reasoning capabilities. No model is hardcoded; missing reasoning metadata is reported as unknown. The project explicitly sends low reasoning by default, including legacy default settings; advertised levels take precedence on model selection if low is unavailable. Provider omission defaults are not assumed. Prompts affect translation style only, never source facts.
- Numeric repair translates text spans and restores original numeric/alphanumeric tokens, including ordinal identifiers and leading zeros. Publication reads reject changed translated identifiers; date-only expiry remains valid through its UTC date. Source fields, coordinates, administrative identity and source execution fingerprints are unchanged.

- A separate cache-only scan runs automatically even when online providers are disabled or cooling down. It has its own persisted cursor, preserves failure history for unrepaired records, consumes no translation requests, and republishes only fully validated cached/canonical results. Scoped catch-up uses the same bounded code path, never manual queue/checkpoint edits.
- Recovery reads source evidence and prior recovery state in bounded groups; administrative name lookup uses indexed aliases while preserving ambiguous-name rejection. Publication rereads every candidate under the existing transaction locks before changing data.
- Cache catch-up fetches translations per bounded source group and computes all affected dataset totals in one grouped query, avoiding repeated evidence-table scans during publication.
- Recovery workers share a PostgreSQL advisory lease. A competing batch waits without dispatching requests, moving cursors or charging attempts; connection closure releases the lease after interruption. Publication still performs its own source fingerprint and contract checks inside the transaction.

## Per-key translation routing revision 7 (2026-09-19)

- OpenAI-compatible, DeepL and Youdao priorities belong to individual credentials. Legacy provider settings seed per-key routes once; dispatch pins the selected credential in both live requests and automatic recovery. Equal priorities rotate; one failed key does not disable sibling keys. Keyless Google retains one independently configurable route.
- The quality-first AI prompt preserves JSON cardinality, digits and identifiers. Model discovery resolves custom API prefixes and supports manual model IDs. All source, language, coordinate, administrative and publication gates remain unchanged.

## Policy and translation consistency revision 8 (2026-09-19)

- Administrative policy keys use lowercase UTF-8 hex, matching PostgreSQL coverage keys. Legacy aliases are normalized transactionally; canonical settings and explicit clears take precedence. Source exhaustion states and stored address facts are preserved.
- Catalog minimums honor explicit node targets. An overridden node without coverage counts as zero and remains unmet; official zero-address nodes stay in the coverage denominator.
- Initial online import translation follows enabled per-key priorities and pins each broker dispatch to its credential. Caller environment, fetch implementation and cancellation propagate to localization; deferred localization remains the default.
- Display translation caches include source component contents, country and native language. Corrected components invalidate old cache entries; unchanged inputs reuse validated translations. Numeric and HTTP-date Retry-After values are respected.
- Existing source, administrative, coordinate, identifier, language and publication gates remain enforced. DeepL credit accounting is unchanged; no periodic refill is introduced for one-time rewards.

## 邮编留空（2026-10-02）

- 本地数字先转 ASCII；不符合本国格式的邮编留空并保留地址，不再以 invalid_postcode 淘汰整条记录。

## 容量扩展（2026-10-03）

- 国家目标由后台设为 5,000,000，各级行政区采样上限设为 0（不限），完成判定仍要求覆盖与节点下限；修改目标不解除来源上限状态。
- 存储预算按缓存文件加 PostgreSQL 数据库计算：软上限 55 GiB、硬上限 60 GiB，磁盘剩余低于 10 GiB 视同已满；单次运行新增量不超过 50,000 条且不超过剩余空间按启用国家数均分的份额（每条按 12 KiB 估算），不会把来源已有数量缩小；因步长截断的成功运行 1 分钟后继续，其余按来源周期复查。
- 文件型开放数据来源提高单次上限并追加适配器版本 `+capacity-20261003`，已耗尽来源按新提取能力重新运行一次：overture（1 个分片）：单次上限 200,000；geofabrik（53 个分片）：单次上限 50,000。
- 地址缺城市时只从来源已给出的一级行政区内选取最近城市，不跨州/省补全。
- 中文道路名（2026-10-06）：普通地址在中文道路名尚未翻译时可先发布，中文版本道路名暂用英文（拉丁字母）原名，城市、一级行政区与国家仍为中文；该地址保持在翻译队列中，译出后替换；积压时（单批候选不少于 200 条）首轮只用已缓存的中文道路名，6 小时后再交翻译供应商。住宅地址仍须完整中文版本才发布。
- 中文地址拼接（2026-10-07）：中文版本各部分直接相连，仅在相邻两部分均以汉字、假名以外的字母或数字（拉丁、西里尔、韩文等）衔接时用空格分隔（如 `HWY 128 17500 95415`）；中文完整地址必须与中文组件一致，同步服务启动时按国家一次性用中文组件重建与之不一致的已存中文地址（旧拼接格式或部分翻译时生成的旧串；修订 `chinese-address-format-v3`，进度按国家持久保存）。
- 中文译名可信度（2026-10-08）：中文组件出现问句或回话（如“它是什么？”）、俄文街道通名（улица、проспект 等）译文缺少“街/路/道/巷”等通名、或较长原名（西里尔文 ≥4 字母、其他文字 ≥5 字母）只译成一个非通名、非方位汉字时，视为不可用翻译：导入与回填拒收并重新翻译，发布校验（修订 `address-reader-v5-implausible-chinese`）将已发布的此类地址撤下，重译合格后自动重新发布；行政目录中文名同样适用此规则，不可信的目录中文名回退为原名并由翻译提供中文，API 仅在目录中文名含汉字且可信时才覆盖已存译名（土耳其 Bursa 目录译名由“囊”更正为“布尔萨”）。
- 损坏文本（2026-10-08）：本地语言组件中紧邻中日韩文字的“?”或替换字符 U+FFFD 表示来源在编码转换中丢失了字符（如 `?榔路`），质量门禁以 `corrupted_text` 拒绝导入与发布，不猜测补字。
- 发布吞吐（2026-10-05）：翻译回填发布只锁定待发布地址行，不再锁整表；国家总量每批更新，行政区覆盖按国家合并为至多每 10 分钟刷新一次（每轮仅刷新一个国家）；数据集有效数按重新激活的行增量更新；发布批次只为新发布地址追加随机抽样序号，不重排全国序号（完整刷新时再压缩空缺）。存在积压时回填连续执行（每批 1,000 条；翻译在批次 75% 时间停止调用供应商并使用已缓存结果，随后发布另有独立 120 秒窗口）。某国已入库但尚未发布的地址超过 20,000 条时，同步队列暂缓该国新导入 30 分钟，待发布追上后恢复。导出进程上限 75 分钟（日本 120–140 分钟），单次同步任务上限 150 分钟。同一数据集中解析到同一地址行的后续记录按重复拒绝，每条地址仅一条主证据。

## 分州 Overture + USA Structures（2026-10-03）

- 导入去重：同一数据集中解析到同一地址行的后续记录按重复拒绝，保证每条地址仅一条主证据。
- 数据源：Overture addresses 最新发布按州分片读取（州 bbox 选资产，`address_levels[1]` 等于州代码过滤），地址、门牌、城市、州、ZIP、坐标均来自 Overture 原记录（主要为 USDOT NAD 与州县公开地址），不插值、不推算门牌。
- 住宅佐证：每州读取 FEMA/ORNL USA Structures 当期州 FileGDB。来源为公开 S3 列表 `https://fema-femadata.s3.amazonaws.com/?list-type=2&prefix=Partners/ORNL/USA_Structures/`（原下载页已跳转为无直链页面），按州目录选取日期最新且日期合法的 `DeliverableYYYYMMDD<州>.zip` 或 `<州>_Structures_YYYYMMDD.zip`，文件名日期作为来源版本。地址点约 30 m 内最近建筑的 `OCC_CLS=Residential` 且 `PRIM_OCC` 属于 Single Family Dwelling / Multi - Family Dwelling / Manufactured Home 时标为住宅（多户为 apartment），证据为该建筑 UUID；最近建筑为非住宅、无建筑或其他住宅子类（临时住宿、宿舍、养老院）时作为普通真实地址发布，不声称住宅。
- 选择：全州地址先完成佐证，再按住宅优先、各城市轮流（hash 稳定顺序）选取，单次上限 200,000 且受存储份额约束；邻近地址随上限增长自然补入。
- 版本：数据集版本为 `<Overture 发布>+usa-structures-<交付日期>`，能力指纹 `usa-structures-nearest-30m-v1` / `state-partition-locality-round-robin-v1`；任一变化才重新运行该州。
- 许可与风险：USA Structures 由联邦机构公开发布，未见明示许可证；占用分类部分来自宗地数据与模型，交付日期 2023–2025，新建或拆除建筑可能未反映。原始 ZIP 与解压文件在导出后删除，不入库。
- 2026-10-03 只读探测（Mississippi）：Overture 门牌地址 1,153,547；建筑内住宅 440,231，最近 30 m 内住宅 373,041，最近为非住宅 141,392，30 m 内无建筑 198,883。

## 邮编补全（2026-10-06）

- 来源缺少邮编时按顺序推断，且只在结果唯一时填写，冲突一律留空：
  1. 坐标落在且仅落在一个邮政区多边形内：美国人口普查局 TIGER/Line 2020 ZCTA5（公有领域；ZCTA 近似 USPS 邮编，个别乡村地址可能不同）；
  2. GeoNames 邮编目录中同一一级行政区下该城市或区县只对应一个邮编，且目录坐标在约 30 km 内（CC BY 4.0）；
  3. 同一城市约 1 km 范围内至少 3 条来源自带邮编的地址邮编一致（推断出的邮编不参与投票）。
- 推断结果写入地址各语言版本，并在 `address_postcode_inference` 记录方法与来源；来源后续提供邮编时以来源为准，来源仍缺失时重新导入保留推断值。

- 同步进展口径（2026-10-09）：一次同步的地址增长只计入该来源本次导入实际新增或恢复发布的行减去其撤下的行；导入未提交（下载、物化或导入阶段失败、超时、中断）时增长为 0，即使同期翻译发布使国家总量上升。队列据此判断来源是否仍有进展，没有自身增长的成功同步按来源已达上限处理；同步历史的增长列采用同一口径，已有失败记录中未提交导入的增长统一更正为 0。重新导入不再恢复被发布校验撤下的地址，这类地址仍由翻译恢复复检合格后再发布。

## 缺少州档案（2026-10-10）

- USA Structures 列表中缺少某州档案时，该州不再使整次美国同步失败：记录警告，地址照常导入，住宅佐证回退到 Overture Buildings；没有住宅证据的地址仍只作普通真实地址发布。
