# HK 中国香港地址生成策略

| 项目 | 核心内容 |
|---|---|
| 主源 | 香港房屋委员会公共租住房屋单位数据 + Digital Policy Office Address Lookup Service（ALS）；香港屋宇署楼宇资料及楼龄纪录 |
| 既有门牌级格式 / 邮编 | `<单位/楼层>, <楼宇>, <门牌> <街道>, <地点>, <18区>, <香港島/九龍/新界>, Hong Kong`；香港没有通用邮编，canonical postcode 保持空值，`999077` 不得入库。 |
| 行政区 | `admin1=地域` 仅允许香港島、九龍、新界；`locality=行政区` 仅允许官方 18 区；`district=地点`。金鐘属于地点，葵青區属于行政区，不得跨层复用；区与地域归属不一致的记录拒绝发布。 |
| 语言 | 原始语言固定为 `zh-HK`，组件和完整地址使用繁体中文；英文单独存入 `en`，简体中文单独存入 `zh-CN`。双语源在导入时拆分，旧记录读取时以简体变体转繁体纠正，不把英文作为原始语言 |
| 住宅子集证据 | 公屋单位由房委会库存直接证明；私人楼宇只接受屋宇署 `Residential/Composite` 且建筑类型为 `Tower` 的记录，不把 podium、商业、工业或其他用途作为住宅 |
| 真实字段 / 生成字段 | 单位/楼层、楼宇、门牌、街道、地点、18 区、地域和坐标来自房委会、ALS 或屋宇署；生成字段：无 |
| 坐标 / 去重 | 官方坐标统一为 WGS84 并通过香港边界门禁；按官方楼宇/单位 ID 和规范化双语门牌地址去重 |
| 发布门禁 | 接受真实街道级与已有门牌级地址；按实际精度检查来源、行政归属、语言和坐标。街道记录不强制门牌，不编造缺失字段；已有真实门牌保留，未知或歧义邮编留空；只有住宅子集要求独立住宅证据。 |
| 街道级格式 | `<三大地域><十八区><街道>`；`matchLevel=street`，门牌、楼栋、室号为空；香港没有通用邮编，postcode 始终留空。 |
| 街道去重 / 验证 | 国家 + 规范行政层级 + 街道名，同一路段不同坐标、邮编或来源 ID 不增加条数；行政字段不使用最近目录点推断。 |
| 同步方式 | 屋宇署年度快照直接导出；房委会季度数据按楼宇去重查询 ALS，并缓存官方门牌、街道和楼宇坐标。新快照通过门禁后原子切换，失败保留上一 active 快照 |
| 既有官方住宅适配器 / 排除 | 仅保留 `Residential/Composite` Tower、官方 18 区、唯一双语街道门牌和香港范围坐标；房委会记录必须与 ALS 精确匹配。 |
| 策略版本 / 状态 / 更新 | 2.8 / 官方 3 地域和 18 区共享目录 + 独立行政派生 + 街道契约 street-v1 / 2026-09-13 |

- 默认国家完成数量下限 20,000；地域、行政区、地点单来源均衡采样上限 10,000/2,000/300，后台可覆盖；国家总量不是发布上限，行政区划目录保持完整。规范化缓存身份包含有效记录上限和行政节点上限，提升配额后不会复用旧的 10,000 条缓存。

- 房委会与 ALS 只在中文屋邨名、楼宇名和区名完全一致且结果唯一时合并；ALS 楼宇坐标与房委会屋邨坐标偏差超过 0.02 度时淘汰。

- 屋宇署完整地址中的剩余文本不推断为楼宇名；仅保存官方完整地址供审计。楼宇名、楼层和单位只由房委会与 ALS 精确匹配结果提供。

- 同一官方记录含多个街道门牌，或中英文街道无法唯一对应同一门牌号时直接淘汰，不任意选择其中一个入口。

- 官方来源：[房委会公共租住房屋库存](https://data.gov.hk/en-data/dataset/hk-housing-emms-emms-housing-stock)、[ALS](https://data.gov.hk/en-data/dataset/hk-dpo-als_01-als)、[屋宇署楼宇资料及楼龄纪录](https://data.gov.hk/en-data/dataset/hk-bd-opendata-building-information)。DATA.GOV.HK 数据条款要求在再分发时保留来源署名和免责声明。


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

## Administrative projection revision 1 (2026-09-13)

- A unique recognized official district supplies its parent geographic region. Conflicting explicit regions/districts, including native administrative codes, are rejected; unrecognized nonempty parent labels stay unresolved. Country-level Hong Kong alone is not an island assignment. Independently versioned derived IDs/labels are shared by generation, filters and both coverage paths; source fields are not overwritten. Stale input hashes disable the derivation.
- Legacy district labels in `admin1` and the existing source catalog's 18 aliases (`HWC`, `KKT`, etc.) are district evidence, not region codes. They must agree with the independently recognized locality district; conflicting codes/names and unrecognized neighborhoods remain excluded. The explicit alias table was checked against [Countries States Cities Database](https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/json/states.json) on 2026-09-13; parent membership follows [Home Affairs Department](https://www.had.gov.hk/en/18_districts/my_map.htm), reviewed 2026-01-21. No nearest-place inference or address source rerun is involved.
- Native Han counterparts are recovered per semantic field, preserving numeric identities. Latin source text is retained when no valid counterpart exists and remains unpublished under the native-script contract; it is not erased and mislabeled as a missing street.

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
- 文件型开放数据来源提高单次上限并追加适配器版本 `+capacity-20261003`，已耗尽来源按新提取能力重新运行一次：overture（1 个分片）：单次上限 200,000；hong-kong-residential（1 个分片）：单次上限 100,000；geofabrik（1 个分片）：单次上限 200,000。
- 地址缺城市时只从来源已给出的一级行政区内选取最近城市，不跨州/省补全。
- 中文道路名（2026-10-06）：普通地址在中文道路名尚未翻译时可先发布，中文版本道路名暂用英文（拉丁字母）原名，城市、一级行政区与国家仍为中文；该地址保持在翻译队列中，译出后替换；积压时（单批候选不少于 200 条）首轮只用已缓存的中文道路名，6 小时后再交翻译供应商。住宅地址仍须完整中文版本才发布。
- 中文地址拼接（2026-10-07）：中文版本各部分直接相连，仅在相邻两部分均以汉字、假名以外的字母或数字（拉丁、西里尔、韩文等）衔接时用空格分隔（如 `HWY 128 17500 95415`）；中文完整地址必须与中文组件一致，同步服务启动时按国家一次性用中文组件重建与之不一致的已存中文地址（旧拼接格式或部分翻译时生成的旧串；修订 `chinese-address-format-v3`，进度按国家持久保存）。
- 中文译名可信度（2026-10-08）：中文组件出现问句或回话（如“它是什么？”）、俄文街道通名（улица、проспект 等）译文缺少“街/路/道/巷”等通名、或较长原名（西里尔文 ≥4 字母、其他文字 ≥5 字母）只译成一个非通名、非方位汉字时，视为不可用翻译：导入与回填拒收并重新翻译，发布校验（修订 `address-reader-v5-implausible-chinese`）将已发布的此类地址撤下，重译合格后自动重新发布；行政目录中文名同样适用此规则，不可信的目录中文名回退为原名并由翻译提供中文，API 仅在目录中文名含汉字且可信时才覆盖已存译名（土耳其 Bursa 目录译名由“囊”更正为“布尔萨”）。
- 损坏文本（2026-10-08）：本地语言组件中紧邻中日韩文字的“?”或替换字符 U+FFFD 表示来源在编码转换中丢失了字符（如 `?榔路`），质量门禁以 `corrupted_text` 拒绝导入与发布，不猜测补字。
- 发布吞吐（2026-10-05）：翻译回填发布只锁定待发布地址行，不再锁整表；国家总量每批更新，行政区覆盖按国家合并为至多每 10 分钟刷新一次（每轮仅刷新一个国家）；数据集有效数按重新激活的行增量更新；发布批次只为新发布地址追加随机抽样序号，不重排全国序号（完整刷新时再压缩空缺）。存在积压时回填连续执行（每批 1,000 条；翻译在批次 75% 时间停止调用供应商并使用已缓存结果，随后发布另有独立 120 秒窗口）。某国已入库但尚未发布的地址超过 20,000 条时，同步队列暂缓该国新导入 30 分钟，待发布追上后恢复。导出进程上限 75 分钟（日本 120–140 分钟），单次同步任务上限 150 分钟。同一数据集中解析到同一地址行的后续记录按重复拒绝，每条地址仅一条主证据。

## 邮编补全（2026-10-06）

- 本国邮编精细到街道或楼栋（或不使用邮编），不按区域或邻近地址推断；来源缺失时保持留空。

- 同步进展口径（2026-10-09）：一次同步的地址增长只计入该来源本次导入实际新增或恢复发布的行减去其撤下的行；导入未提交（下载、物化或导入阶段失败、超时、中断）时增长为 0，即使同期翻译发布使国家总量上升。队列据此判断来源是否仍有进展，没有自身增长的成功同步按来源已达上限处理；同步历史的增长列采用同一口径，已有失败记录中未提交导入的增长统一更正为 0。重新导入不再恢复被发布校验撤下的地址，这类地址仍由翻译恢复复检合格后再发布。

## 屋宇署来源发现（2026-10-10）

- 屋宇署数据集在 DATA.GOV.HK 更换了资源 ID，旧资源页返回 404，自 2026-08-17 起同步失败。发现改用 CKAN `package_show?id=hk-bd-opendata-building-information`：取状态为 active、下载地址为 `static.csdi.gov.hk/.../csv` 的资源，资源 `metadata_modified` 日期作为来源版本。数据集 ID 不变时，资源再次替换无需改代码；字段映射、住宅门禁和导出版本不变。
