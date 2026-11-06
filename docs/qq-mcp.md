# QQ MCP Server（给别的 AI 用你的 QQ）

这个 server 把 SnowLuma（OneBot 11）的接口包成 MCP 工具。
**用途**：让 Claude Desktop / Cursor / 别的支持 MCP 的 agent 能读你的 QQ 消息、发消息、管群。

**注意**：它是给别人用的入口，不是阿糯自己用的。
阿糯自己用的是 `src/mcp/client.js` + `.data/mcp.json`（另一套，方向相反）。

---

## 一、启动方式

不需要安装任何东西，用项目自带的 node：

```bash
tools\node\node.exe src\mcp\qq-server.js
```

它走 stdio，由 MCP 客户端自动拉起，**不用手动开**。

需要两个环境变量（跟 `.env` 一致）：

```
ONEBOT_HTTP_URL=http://127.0.0.1:3000
ONEBOT_HTTP_TOKEN=你的token
```

`qq-server.js` 会自动读 `.env`，所以直接跑也行。

## 二、接到别的客户端

**Claude Desktop**（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "qq": {
      "command": "D:\\大肥鱼工作区\\AI好玩\\大肥鱼成精\\tools\\node\\node.exe",
      "args": ["D:\\大肥鱼工作区\\AI好玩\\大肥鱼成精\\src\\mcp\\qq-server.js"]
    }
  }
}
```

**Cursor**（`.cursor/mcp.json`）：同样格式。

**任何 MCP 客户端**：command 填 node 路径，args 填 server 路径即可。

## 三、提供了哪些工具（37 个）

### 看状态

| 工具 | 作用 |
|---|---|
| `qq_login_info` | 这个号是谁 |
| `qq_status` | OneBot 在不在线、消息通不通 |
| `qq_online_clients` | 在哪些设备登录（SnowLuma 可能返回空） |

### 发消息

| 工具 | 作用 |
|---|---|
| `qq_send_private` | 私聊发文字/图片，可引用 |
| `qq_send_group` | 群发文字/图片，可 @、可引用 |
| `qq_send_voice` | 群里用 AI 音色发语音 |
| `qq_recall` | 撤回消息 |
| `qq_upload_group_file` | 往群里传文件 |
| `qq_upload_private_file` | 给某人传文件 |

### 读

| 工具 | 作用 |
|---|---|
| `qq_group_history` | 群聊天记录 |
| `qq_friend_list` | 好友列表 |
| `qq_group_list` | 群列表 |
| `qq_group_members` | 群成员 |
| `qq_group_info` | 群资料 |
| `qq_member_info` | 某个群成员的资料 |
| `qq_user_info` | 某人资料 |
| `qq_recent_contacts` | 最近联系人 |

### 互动

| 工具 | 作用 |
|---|---|
| `qq_poke` | 戳一戳 |
| `qq_like` | 点赞 |
| `qq_set_signature` | 改签名 |
| `qq_set_nickname` | 改昵称 |
| `qq_set_avatar` | 换头像 |

### 群管理（破坏性，都标了"确认了再做"）

| 工具 | 作用 |
|---|---|
| `qq_set_card` | 改群名片 |
| `qq_mute` | 禁言 |
| `qq_kick` | 踢人 |
| `qq_whole_ban` | 全员禁言 |
| `qq_set_admin` | 设管理 |
| `qq_set_group_name` | 改群名 |
| `qq_group_notice` | 发群公告 |
| `qq_group_sign` | 群签到 |
| `qq_leave_group` | 退群 |

### 好友 / 请求

| 工具 | 作用 |
|---|---|
| `qq_set_friend_remark` | 改好友备注 |
| `qq_delete_friend` | 删好友 |
| `qq_handle_friend_request` | 处理加好友请求 |
| `qq_handle_group_request` | 处理加群请求 |

### 语音

| 工具 | 作用 |
|---|---|
| `qq_ai_voices` | 查某群能用的音色 |
| `qq_send_voice` | 用音色发语音 |

### 兜底

| 工具 | 作用 |
|---|---|
| `qq_raw` | 直接调任意 OneBot 接口（高级用法，凭据类被拦） |

## 四、安全

```
· 不暴露 cookies / csrf / 登录凭据类接口（qq_raw 里按名字拦截）
· 破坏性操作在描述里写明"确认了再做"，但不会替你确认——
  接它的 agent 需要自己判断
· 它用你 .env 里的 token 访问本机 3000 端口，不对外网开放
```

## 五、测过什么

```
✓ 工具发现：37 个
✓ qq_login_info   → 3902064605 阿糯
✓ qq_group_list   → 开心一家人 等
✓ qq_group_info   → 群资料正常
✓ qq_member_info  → 成员资料正常
✓ qq_friend_list  → 好友列表正常
✓ qq_ai_voices    → 返回可用音色
✗ qq_online_clients → SnowLuma 侧限制：需要先观察到登录快照
✗ qq_recent_contacts → 返回空（SnowLuma 这个接口可能没数据）
```
