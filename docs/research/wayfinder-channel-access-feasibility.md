# 外部消息与服务接入路径：官方接口可行性初查

调查日期：2026-11-26
关联决策票据：[Research access paths for Chinese services and device notifications](https://github.com/clementineyyy/pi/issues/5)

## 结论摘要

- “登录个人账号”不等于 agent 自动获得该账号的全部消息和数据。查到的正式接入均以应用登记、用户同意、授权 scope、API 权限或平台审核为边界。
- 微信和 QQ 的公开 OAuth 主要能证明第三方应用登录/身份授权能力；目前没有在所查官方资料中确认普通第三方应用可读取用户个人微信/QQ收件箱或历史私聊。
- 淘宝开放平台有商品及业务 API，也有消费者/商家授权流程；每个 API 和应用类型的权限不同。商品 API 的存在不能直接证明可稳定获得所有面向消费者的价格、库存或优惠信息。
- 支付宝开放平台文档主要按商户、自用应用和服务商/ISV 集成组织。查到第三方商家授权机制，但未确认个人消费者交易明细等通用读取 API。
- 邮件和日历是目前证据最清楚的接入方向：Google 与 Microsoft 都提供 OAuth、资源读取及服务器端变更通知。订阅会过期或可能漏消息，需要续订与补偿同步。
- Windows 有通知监听 API，用户必须授权且能撤销。Apple 的公开 UserNotifications 文档描述本应用自己的本地/远程通知；没有在所查资料中找到读取其他 iOS 应用通知的公开 API。iOS 静默推送用于唤醒本应用刷新内容，系统不保证送达且会节流。
- 公开网页可通过搜索 API 或抓取可访问 URL 获取。RFC 9309 明确指出 robots.txt 不是访问授权；它不能替代身份验证或访问控制，也不能作为“可以抓取”的许可。

## 服务与访问路径

| 来源 | 已核实的官方能力 | 对个人 agent 的限制或未知 |
| --- | --- | --- |
| 微信 | 腾讯云开发者社区页面链接微信开放平台网站应用登录文档，并说明经用户扫码授权后，通过 code 换取 scope 受限的 access token 和用户基本资料。 | 这是登录/身份授权，不等于读个人消息。微信官方文档页面在本次浏览工具中无法直接打开；未确认个人微信收件箱/聊天记录 API。公众号消息推送是公众号运营者自己的服务能力，不是代读普通用户的微信收件箱。需在具体功能阶段核对对应官方开放能力和资质。 |
| QQ | QQ互联官方 OAuth 文档列有 Authorization Code、Access Token、OpenID 和 OpenAPI；QQ Bot 官方文档支持自建机器人，通过 WebSocket 或 Webhook 收事件。 | OAuth/机器人接口针对接入应用或自建机器人；不能据此推断可读取用户现有 QQ 私聊、群聊或通知历史。QQ Bot 需要开放平台注册、主体认证、创建机器人和配置服务范围。 |
| 淘宝 | TOP 官方 API 文档说明 HTTP API、应用 AppKey、签名，以及只对标记为需授权的 API 提供 session 的规则。公开 API 文档列出商品相关接口；淘宝授权文档描述消费者/商家授权和 scope。 | API 权限按应用能力包申请；部分用户数据需用户登录授权。已找到的商品查询接口并不证明能覆盖前台搜索、促销价、优惠券、库存等购物比价所需字段。需针对具体商品查询 API、授权角色及使用资格再核实。 |
| 支付宝 | 官方平台支持网页/移动应用、生活号、第三方应用和服务商集成；应用需创建登记，按业务开通能力，某些接口还需商家授权。 | 现有证据主要指向支付/商家服务集成。未确认个人消费者账户的通用账单、聊天或通知读取 API。需要按具体 API 和申请条件核实，不能把商户授权等同于个人用户授权。 |
| Gmail / Google Calendar | Gmail API 支持 OAuth 和 mailbox watch，通过 Cloud Pub/Sub 把变更通知交给服务端；Calendar API 支持 OAuth、webhook watch 和事件查询。 | Gmail watch 最长需每 7 天续期，Google 建议每天续期；通知可能延迟或丢失，需以 history API 补同步。Calendar 通知本身通常只告知资源变化，需另调 API 获取详情，渠道也需管理到期。服务地域、用户账号和 Google Cloud 项目资格未在本次调查中核实。 |
| Outlook / Microsoft 365 | Microsoft Graph 支持用户委托 OAuth；邮件和日历资源可订阅变更通知，并通过 webhook 等方式投递。 | 订阅要求资源读取权限；委托权限只能覆盖登录用户有权访问的邮箱/日历。订阅需续期并处理生命周期通知，部署还需可公开访问的 webhook。个人 Microsoft 帐号和组织帐号支持的资源范围不同。 |

## 操作系统通知

### Windows

Microsoft 的 `UserNotificationListener` 可读取 Windows 通知中心中的通知。应用需在 manifest 声明 User Notification Listener capability，并在运行时向用户请求授权；用户可在 Windows 设置中撤销。文档说明当前 listener 支持的通知种类为 app notifications，撤销后 API 可能返回空结果。它适合作为 PC 在线时的本地输入适配器；无法替代云端接入，也不能在 PC 关机时采集通知。

### iOS

Apple 的 UserNotifications 框架用于应用安排本地通知、接收发给该应用的 APNs 远程通知和处理用户交互。已查文档没有提供枚举或读取其他 app 通知中心内容的接口。因此目前不能把 iOS 系统通知读取作为已确认能力；应在 iOS 相关 ticket 中验证平台审核规则和可行替代路径。

Apple 的后台静默推送可唤醒本应用刷新服务端变化，但系统将其视为低优先级，不保证送达，并可能节流。它适合刷新 UI，不适合作为唯一的任务调度或消息接收保证。持续运行应由云端服务承担，手机端接收云端生成的 APNs 提醒。

## 公共网页搜索与抓取

- Google Custom Search JSON API 可为已配置的 Programmable Search Engine 程序化返回搜索结果；这是受搜索引擎配置和 API 配额约束的搜索接口，不代表无限制的全网搜索。
- Brave Search 提供官方 Web Search API，可返回网页搜索结果；使用需要 API 凭证，并应核实定价、地域可用性和当前服务条款。
- 对公开网页直接抓取时，RFC 9309 规定 robots.txt 是 crawler 应遵守的访问规则，但明确声明它不是授权机制。页面公开可访问、robots.txt 未禁止、用户拥有账号、以及服务条款允许自动化是不同判断；robots.txt 本身不能证明拥有抓取许可。登录后页面、反自动化措施及平台规则需要另行评估，本次没有做法律结论。

## 对后续决策的影响

1. 优先把邮件/日历官方 API、公开网页搜索 API 与 PC 本地通知监听作为不同 connector 类型讨论，不要把“登录账号”抽象成统一的数据访问能力。
2. 对微信、QQ、淘宝、支付宝逐个平台核实“目标功能 → 官方 API → 申请/主体要求 → 用户授权范围 → 事件推送方式 → 续期和限流”。当前资料不足以承诺可读取个人聊天消息或支付宝个人账单。
3. 若需要读取 Windows 通知，相关能力必须留在 PC 在线时运行的本地组件；云端可持续工作依赖服务端 connector、官方 webhook 或受支持的轮询。
4. iOS 通知能力应按“给自己的 app 发通知”和“读取别的 app 通知”两类需求分开。当前公开文档支持前者，没有验证后者。
5. 购物比价应作为独立能力研究：确认官方商品搜索/价格字段覆盖后，再决定 API、联盟/第三方数据源和网页检索的组合。

## 官方来源

### 微信与 QQ

- [微信开放平台：网站应用微信登录（官方文档地址；本次工具无法直接打开）](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html)
- [微信扫码登录：腾讯云开发者社区说明并链接官方文档](https://developer.cloud.tencent.com/article/2434546?policyId=1004)
- [QQ互联 OAuth2.0 开发文档](https://wiki.connect.qq.com/oauth2-0%E5%BC%80%E5%8F%91%E6%96%87%E6%A1%A3/)
- [QQ Bot 官方接入指南](https://bot.q.qq.com/wiki/)

### 淘宝与支付宝

- [淘宝开放平台：API 调用方法](https://developer.alibaba.com/docs/doc.htm?articleId=101617&docType=1&treeId=153)
- [淘宝开放平台：用户授权说明](https://developer.alibaba.com/docs/doc.htm?articleId=102635&docType=1&treeId=813)
- [淘宝开放平台：消费者/商家 scope 授权](https://developer.alibaba.com/docs/doc.htm?articleId=119119&docType=1&treeId=634)
- [淘宝开放平台：商品 API 文档示例](https://developer.alibaba.com/docs/api.htm?apiId=10)
- [支付宝开放平台：入驻及应用接入流程](https://openhome.alipay.com/platform/accessProcessPage.htm)
- [支付宝开放平台：文档中心](https://openhome.alipay.com/docCenter/docCenter.htm)
- [支付宝开放平台：应用登记、审核、API 权限与商家授权示例](https://developer.alibaba.com/docs/doc.htm?articleId=105224&docType=1&treeId=193)

### 邮件、日历与设备通知

- [Gmail API：OAuth scope 说明](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Gmail API：配置 Push 通知](https://developers.google.com/workspace/gmail/api/guides/push)
- [Gmail API：users.watch](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch)
- [Google Calendar API：Push 通知](https://developers.google.com/workspace/calendar/api/guides/push)
- [Microsoft Graph：用户委托访问](https://learn.microsoft.com/graph/auth-v2-user)
- [Microsoft Graph：Outlook 变更通知](https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview?tabs=http)
- [Microsoft Graph：订阅权限和限制](https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions?view=graph-rest-1.0)
- [Microsoft Learn：Windows Notification Listener](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener)
- [Apple Developer：UserNotifications](https://developer.apple.com/documentation/usernotifications)
- [Apple Developer：推送后台更新及低优先级限制](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app)

### Web 搜索与抓取

- [Google Programmable Search Engine：Custom Search JSON API](https://developers.google.com/custom-search/v1/overview)
- [Brave Search API：Web Search](https://api-dashboard.search.brave.com/documentation/services/web-search)
- [IETF RFC 9309：Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html)
- [Google Search Central：robots.txt 的用途和限制](https://developers.google.com/search/docs/crawling-indexing/robots/intro)

## 调查局限

本次只查了公开官方文档及平台官方开发者站点，未创建平台开发者账号、申请 API 权限、验证个人账号授权或实际调用接口。微信官方文档页面无法通过本次浏览工具直接打开，因此相关结论保持保守；QQ 官方 OAuth 文档确认了登录和 OpenAPI 文档入口，但未逐项审查全部 OpenAPI。各平台的资格、定价、服务地区和产品策略可能变化，具体接入前需再次核验。
