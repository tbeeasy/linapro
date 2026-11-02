## ADDED Requirements

### Requirement: 文本消息发送接口

共享库 SHALL 提供文本消息发送能力 `SendText(ctx, receiveIDType, receiveID, text)`，
以 `msg_type=text` 调用飞书消息发送接口，复用库内已有的 429 限流退避 HTTP 客户端。
发送成功 SHALL 返回飞书 `message_id`；失败 SHALL 返回携带飞书 `req_id`/`code`/`msg`
的错误。

共享库 SHALL 另提供 `BuildTextContent(text)`，把纯文本编码为 text 消息的 content JSON
串，转义须严格（引号、反斜杠、换行、制表符、控制字符、非 BMP 字符），并在文本超出长度
上限时返回错误而非截断。

#### Scenario: 发送一条文本

- **WHEN** 调用 `SendText` 且接收者类型为 `user_id`、提供有效接收者 ID 与文本
- **THEN** 返回非空 `message_id`

#### Scenario: 飞书拒绝发送

- **WHEN** 飞书返回失败（如接收者不在应用可见范围）
- **THEN** 返回的错误包含飞书 `code` 与 `req_id`，便于调用方定位

#### Scenario: 文本含特殊字符

- **WHEN** 文本包含双引号、反斜杠、换行或 emoji
- **THEN** `BuildTextContent` 产出的 JSON 可被正确解析且内容与原文一致

#### Scenario: 文本为空或超长

- **WHEN** 文本为空字符串或超过长度上限
- **THEN** 返回参数错误，不发起飞书请求

### Requirement: 文件与图片上传及发送

共享库 SHALL 提供文件上传（`UploadFile`，对应飞书 `im/v1/files`，返回 `file_key`）、图片上传
（`UploadImage`，对应 `im/v1/images`，`image_type=message`，返回 `image_key`），以及发送文件消息
（`SendFile`，`msg_type=file`）与图片消息（`SendImage`，`msg_type=image`）的能力，复用库内 429 限流
退避客户端与结构化飞书错误。共享库 SHALL 提供按文件名推导飞书 `file_type` 与按内容识别可上传图片
格式的辅助函数，并公开文件 30 MB、图片 10 MB 两个上限常量。

#### Scenario: 上传文件后发送

- **WHEN** 以推送应用凭据上传一个 PDF 并以返回的 `file_key` 发送文件消息
- **THEN** 两步均成功，返回非空 `message_id`

#### Scenario: 上传被飞书拒绝

- **WHEN** 飞书上传接口返回失败
- **THEN** 返回的错误包含飞书 `code` 与 `req_id`

