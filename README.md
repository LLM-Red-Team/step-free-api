# 跃问YueWen Free 服务

[![](https://img.shields.io/github/license/llm-red-team/step-free-api.svg)](LICENSE)
![](https://img.shields.io/github/stars/llm-red-team/step-free-api.svg)
![](https://img.shields.io/github/forks/llm-red-team/step-free-api.svg)
![](https://img.shields.io/docker/pulls/vinlic/step-free-api.svg)

支持高速流式输出、支持多轮对话、支持联网搜索、支持长文档解读、支持图像解析，零配置部署，多路token支持，自动清理会话痕迹。

与ChatGPT接口完全兼容。

还有以下九个free-api欢迎关注：

Moonshot AI（Kimi.ai）接口转API [kimi-free-api](https://github.com/LLM-Red-Team/kimi-free-api)

阿里通义 (Qwen) 接口转API [qwen-free-api](https://github.com/LLM-Red-Team/qwen-free-api)

智谱AI (智谱清言) 接口转API [glm-free-api](https://github.com/LLM-Red-Team/glm-free-api)

秘塔AI (Metaso) 接口转API [metaso-free-api](https://github.com/LLM-Red-Team/metaso-free-api)

字节跳动（豆包）接口转API [doubao-free-api](https://github.com/LLM-Red-Team/doubao-free-api)

讯飞星火（Spark）接口转API [spark-free-api](https://github.com/LLM-Red-Team/spark-free-api)

MiniMax（海螺AI）接口转API [hailuo-free-api](https://github.com/LLM-Red-Team/hailuo-free-api)

深度求索（DeepSeek）接口转API [deepseek-free-api](https://github.com/LLM-Red-Team/deepseek-free-api)

聆心智能 (Emohaa) 接口转API [emohaa-free-api](https://github.com/LLM-Red-Team/emohaa-free-api)

## 目录

* [免责声明](#免责声明)
* [在线体验](#在线体验)
* [效果示例](#效果示例)
* [接入准备](#接入准备)
  * [多账号接入](#多账号接入)
* [Docker部署](#Docker部署)
  * [Docker-compose部署](#Docker-compose部署)
* [Render部署](#Render部署)
* [Vercel部署](#Vercel部署)
* [原生部署](#原生部署)
* [推荐使用客户端](#推荐使用客户端)
* [接口列表](#接口列表)
  * [对话补全](#对话补全)
  * [文档解读](#文档解读)
  * [图像解析](#图像解析)
  * [refresh_token存活检测](#refresh_token存活检测)
* [注意事项](#注意事项)
  * [Nginx反代优化](#Nginx反代优化)
  * [Token统计](#Token统计)
* [Star History](#star-history)

## 免责声明

**逆向API是不稳定的，建议前往阶跃星辰官方 https://platform.stepfun.com/ 付费使用API，避免封禁的风险。**

**本组织和个人不接受任何资金捐助和交易，此项目是纯粹研究交流学习性质！**

**仅限自用，禁止对外提供服务或商用，避免对官方造成服务压力，否则风险自担！**

**仅限自用，禁止对外提供服务或商用，避免对官方造成服务压力，否则风险自担！**

**仅限自用，禁止对外提供服务或商用，避免对官方造成服务压力，否则风险自担！**

## 在线体验

此链接仅临时测试功能，不可长期使用，长期使用请自行部署。

https://udify.app/chat/RGqDVPHspgQgGSgf

## 效果示例

### 验明正身Demo

![验明正身](./doc/example-1.png)

### 多轮对话Demo

![多轮对话](./doc/example-2.png)

### 联网搜索Demo

![联网搜索](./doc/example-3.png)

### 长文档解读Demo

![长文档解读](./doc/example-4.png)

### 图像解析Demo

![图像解析](./doc/example-6.png)

## 接入准备

从 [yuewen.cn](https://yuewen.cn) 获取deviceId和Oasis-Token

进入StepChat随便发起一个对话，然后F12打开开发者工具。

1. 从Application > LocalStorage中找到 `deviceId` 的值（去除双引号），如：`267bcc81a01c2032a11a3fc6ec3e372c380eb9d1`

![example7](./doc/example-7.png)

2. 从Application > Cookies中找到 `Oasis-Token` 的值，如：`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`

![example5](./doc/example-5.png)

3. 将 `deviceId` 和 `Oasis-Token` 使用 `@` 拼接为Token，这将作为Authorization的Bearer Token值：`Authorization: Bearer 267bcc81a01c2032a11a3fc6ec3e372c380eb9d1@eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`

### 多账号接入

你可以通过提供多个账号的refresh_token并使用`,`拼接提供：

`Authorization: Bearer TOKEN1,TOKEN2,TOKEN3`

每次请求服务会从中挑选一个。

## Docker部署

请准备一台具有公网IP的服务器并将8000端口开放。

拉取镜像并启动服务

```shell
docker run -it -d --init --name step-free-api -p 8000:8000 -e TZ=Asia/Shanghai vinlic/step-free-api:latest
```

查看服务实时日志

```shell
docker logs -f step-free-api
```

重启服务

```shell
docker restart step-free-api
```

停止服务

```shell
docker stop step-free-api
```

### Docker-compose部署

```yaml
version: '3'

services:
  step-free-api:
    container_name: step-free-api
    image: vinlic/step-free-api:latest
    restart: always
    ports:
      - "8000:8000"
    environment:
      - TZ=Asia/Shanghai
```

### Render部署

**注意：部分部署区域可能无法连接step，如容器日志出现请求超时或无法连接，请切换其他区域部署！**
**注意：免费账户的容器实例将在一段时间不活动时自动停止运行，这会导致下次请求时遇到50秒或更长的延迟，建议查看[Render容器保活](https://github.com/LLM-Red-Team/free-api-hub/#Render%E5%AE%B9%E5%99%A8%E4%BF%9D%E6%B4%BB)**

1. fork本项目到你的github账号下。

2. 访问 [Render](https://dashboard.render.com/) 并登录你的github账号。

3. 构建你的 Web Service（New+ -> Build and deploy from a Git repository -> Connect你fork的项目 -> 选择部署区域 -> 选择实例类型为Free -> Create Web Service）。

4. 等待构建完成后，复制分配的域名并拼接URL访问即可。

### Vercel部署

**注意：Vercel免费账户的请求响应超时时间为10秒，但接口响应通常较久，可能会遇到Vercel返回的504超时错误！**

请先确保安装了Node.js环境。

```shell
npm i -g vercel --registry http://registry.npmmirror.com
vercel login
git clone https://github.com/LLM-Red-Team/step-free-api
cd step-free-api
vercel --prod
```

## 原生部署

请准备一台具有公网IP的服务器并将8000端口开放。

请先安装好Node.js环境并且配置好环境变量，确认node命令可用。

安装依赖

```shell
npm i
```

安装PM2进行进程守护

```shell
npm i -g pm2
```

编译构建，看到dist目录就是构建完成

```shell
npm run build
```

启动服务

```shell
pm2 start dist/index.js --name "step-free-api"
```

查看服务实时日志

```shell
pm2 logs step-free-api
```

重启服务

```shell
pm2 reload step-free-api
```

停止服务

```shell
pm2 stop step-free-api
```

## 推荐使用客户端

使用以下二次开发客户端接入free-api系列项目更快更简单，支持文档/图像上传！

由 [Clivia](https://github.com/Yanyutin753/lobe-chat) 二次开发的LobeChat [https://github.com/Yanyutin753/lobe-chat](https://github.com/Yanyutin753/lobe-chat)

由 [时光@](https://github.com/SuYxh) 二次开发的ChatGPT Web [https://github.com/SuYxh/chatgpt-web-sea](https://github.com/SuYxh/chatgpt-web-sea)

## 接口列表

目前支持与openai兼容的 `/v1/chat/completions` 接口，可自行使用与openai或其他兼容的客户端接入接口，或者使用 [dify](https://dify.ai/) 等线上服务接入使用。

### 对话补全

对话补全接口，与openai的 [chat-completions-api](https://platform.openai.com/docs/guides/text-generation/chat-completions-api) 兼容。

**POST /v1/chat/completions**

header 需要设置 Authorization 头部：

```
Authorization: Bearer [refresh_token]
```

请求数据：
```json
{
    // 模型名称随意填写
    "model": "step",
    "messages": [
        {
            "role": "user",
            "content": "你是谁？"
        }
    ],
    // 如果使用SSE流请设置为true，默认false
    "stream": false
}
```

响应数据：
```json
{
    "id": "85466015488159744",
    "model": "step",
    "object": "chat.completion",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "我是跃问(StepChat)，一个由阶跃星辰(StepFun)开发的多模态大模型。我可以回答您的问题，提供信息和帮助，同时支持多种模态的交互，如文字、图像等。如果您有任何问题或需要帮助，请随时向我提问。"
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 1,
        "completion_tokens": 1,
        "total_tokens": 2
    },
    "created": 1711829974
}
```

### 文档解读

提供一个可访问的文件URL或者BASE64_URL进行解析。

**POST /v1/chat/completions**

header 需要设置 Authorization 头部：

```
Authorization: Bearer [refresh_token]
```

请求数据：
```json
{
    // 模型名称随意填写
    "model": "step",
    "messages": [
        {
            "role": "user",
            "content": [
                {
                    "type": "file",
                    "file_url": {
                        "url": "https://mj101-1317487292.cos.ap-shanghai.myqcloud.com/ai/test.pdf"
                    }
                },
                {
                    "type": "text",
                    "text": "文档里说了什么？"
                }
            ]
        }
    ]
}
```

响应数据：
```json
{
    "id": "85774360661086208",
    "model": "step",
    "object": "chat.completion",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "这是一个关于爱情魔法的文档。它包含了四个部分：\n\n1. **PMG 4.1390 – 1495**：这是一个使用面包和咒语来吸引心仪女性的仪式。仪式中需要将面包分成七个小块，并在特定地点进行咒语的念诵和投掷。\n2. **PMG 4.1342 – 57**：这是一个召唤恶魔来使一个名叫Tereous的女性受到折磨，直到她与一个名叫Didymos的人相爱并结合的咒语。\n3. **PGM 4.1265 – 74**：这是关于如何赢得一个美丽的女人的咒语。它涉及到连续三天保持纯洁，向女神阿佛洛狄特（Aphrodite）供奉乳香，并在心中默念她的神秘名字。\n4. **PGM 4.1496 – 1**：这是一个使用没药来吸引一个特定女性的咒语。这个咒语需要在煤上焚烧没药的同时念诵，目的是让这个女性心中只想着施咒者，并最终与施咒者相爱。"
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 1,
        "completion_tokens": 1,
        "total_tokens": 2
    },
    "created": 1711903489
}
```

### 图像解析

提供一个可访问的图像URL或者BASE64_URL进行解析。

此格式兼容 [gpt-4-vision-preview](https://platform.openai.com/docs/guides/vision) API格式，您也可以用这个格式传送文档进行解析。

**POST /v1/chat/completions**

header 需要设置 Authorization 头部：

```
Authorization: Bearer [refresh_token]
```

请求数据：
```json
{
    // 模型名称随意填写
    "model": "step",
    "messages": [
        {
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {
                        "url": "https://k.sinaimg.cn/n/sinakd20111/106/w1024h682/20240327/babd-2ce15fdcfbd6ddbdc5ab588c29b3d3d9.jpg/w700d1q75cms.jpg"
                    }
                },
                {
                    "type": "text",
                    "text": "图像描述了什么？"
                }
            ]
        }
    ]
}
```

响应数据：
```json
{
    "id": "85773574417829888",
    "model": "step",
    "object": "chat.completion",
    "choices": [
        {
        "index": 0,
        "message": {
            "role": "assistant",
            "content": "这张图片展示了一个活动现场，似乎是某种新产品或技术的发布会。图片中央有一个大屏幕，上面写着“创新技术及产品首发”，屏幕上还展示了一些公司的标志或名称，如“RWKV”、“财跃星辰”、“阶跃星辰”、“商汤”和“零方科技”。在屏幕下方的舞台上，有几位穿着正装的人士正在进行互动，可能是在进行产品发布或演示。整个场景给人一种正式且科技感十足的印象。"
        },
        "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 1,
        "completion_tokens": 1,
        "total_tokens": 2
    },
    "created": 1711903302
}
```

### refresh_token存活检测

检测refresh_token是否存活，如果存活live未true，否则为false，请不要频繁（小于10分钟）调用此接口。

**POST /token/check**

请求数据：
```json
{
    "token": "267bcc81a01c2032a11a3fc6ec3e372c380eb9d1@eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

响应数据：
```json
{
    "live": true
}
```

## 注意事项

### Nginx反代优化

如果您正在使用Nginx反向代理step-free-api，请添加以下配置项优化流的输出效果，优化体验感。

```nginx
# 关闭代理缓冲。当设置为off时，Nginx会立即将客户端请求发送到后端服务器，并立即将从后端服务器接收到的响应发送回客户端。
proxy_buffering off;
# 启用分块传输编码。分块传输编码允许服务器为动态生成的内容分块发送数据，而不需要预先知道内容的大小。
chunked_transfer_encoding on;
# 开启TCP_NOPUSH，这告诉Nginx在数据包发送到客户端之前，尽可能地发送数据。这通常在sendfile使用时配合使用，可以提高网络效率。
tcp_nopush on;
# 开启TCP_NODELAY，这告诉Nginx不延迟发送数据，立即发送小数据包。在某些情况下，这可以减少网络的延迟。
tcp_nodelay on;
# 设置保持连接的超时时间，这里设置为120秒。如果在这段时间内，客户端和服务器之间没有进一步的通信，连接将被关闭。
keepalive_timeout 120;
```

### Token统计

由于推理侧不在step-free-api，因此token不可统计，将以固定数字返回!!!!!

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=LLM-Red-Team/step-free-api&type=Date)](https://star-history.com/#LLM-Red-Team/step-free-api&Date)
