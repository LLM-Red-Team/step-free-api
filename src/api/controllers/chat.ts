import { PassThrough } from "stream";
import path from "path";
import _ from "lodash";
import mime from "mime";
import axios, { AxiosResponse } from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

// 模型名称
const MODEL_NAME = "step";
// access_token有效期
const ACCESS_TOKEN_EXPIRES = 900;
// 最大重试次数
const MAX_RETRY_COUNT = 0;
// 重试延迟
const RETRY_DELAY = 5000;
// 伪装headers
const FAKE_HEADERS = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Origin: "https://stepchat.cn",
  "Connect-Protocol-Version": "1",
  "Oasis-Appid": "10200",
  "Oasis-Platform": "web",
  "Oasis-Webid": util.uuid(),
  "Sec-Ch-Ua":
    '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};
// 文件最大大小
const FILE_MAX_SIZE = 100 * 1024 * 1024;
// access_token映射
const accessTokenMap = new Map();
// access_token请求队列映射
const accessTokenRequestQueueMap: Record<string, Function[]> = {};

/**
 * 请求access_token
 *
 * 使用refresh_token去刷新获得access_token
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function requestToken(refreshToken: string) {
  if (accessTokenRequestQueueMap[refreshToken])
    return new Promise((resolve) =>
      accessTokenRequestQueueMap[refreshToken].push(resolve)
    );
  accessTokenRequestQueueMap[refreshToken] = [];
  logger.info(`Refresh token: ${refreshToken}`);
  const result = await (async () => {
    const result = await axios.post(
      "https://stepchat.cn/passport/proto.api.passport.v1.PassportService/RegisterDevice",
      {},
      {
        headers: {
          Cookie: `Oasis-Token=${refreshToken}`,
          Referer: "https://stepchat.cn/chats/new",
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    );
    const {
      accessToken: { raw: accessTokenRaw },
      refreshToken: { raw: refreshTokenRaw },
      device: { deviceID: deviceId },
    } = checkResult(result, refreshToken);
    return {
      deviceId,
      accessToken: accessTokenRaw,
      refreshToken: refreshTokenRaw,
      refreshTime: util.unixTimestamp() + ACCESS_TOKEN_EXPIRES,
    };
  })()
    .then((result) => {
      if (accessTokenRequestQueueMap[refreshToken]) {
        accessTokenRequestQueueMap[refreshToken].forEach((resolve) =>
          resolve(result)
        );
        delete accessTokenRequestQueueMap[refreshToken];
      }
      logger.success(`Refresh successful`);
      return result;
    })
    .catch((err) => {
      if (accessTokenRequestQueueMap[refreshToken]) {
        accessTokenRequestQueueMap[refreshToken].forEach((resolve) =>
          resolve(err)
        );
        delete accessTokenRequestQueueMap[refreshToken];
      }
      return err;
    });
  if (_.isError(result)) throw result;
  return result;
}

/**
 * 获取缓存中的access_token
 *
 * 避免短时间大量刷新token，未加锁，如果有并发要求还需加锁
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function acquireToken(refreshToken: string) {
  let result = accessTokenMap.get(refreshToken);
  if (!result) {
    result = await requestToken(refreshToken);
    accessTokenMap.set(refreshToken, result);
  }
  if (util.unixTimestamp() > result.refreshTime) {
    result = await requestToken(refreshToken);
    accessTokenMap.set(refreshToken, result);
  }
  return {
    deviceId: result.deviceId,
    token: result.accessToken + "..." + result.refreshToken,
  };
}

/**
 * 创建会话
 *
 * 创建临时的会话用于对话补全
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function createConversation(name: string, refreshToken: string) {
  const { deviceId, token } = await acquireToken(refreshToken);
  const result = await axios.post(
    "https://stepchat.cn/api/proto.chat.v1.ChatService/CreateChat",
    {
      chatName: name,
    },
    {
      headers: {
        Cookie: generateCookie(deviceId, token),
        "Oasis-Webid": deviceId,
        Referer: "https://stepchat.cn/chats/new",
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  const { chatId: convId } = checkResult(result, refreshToken);
  return convId;
}

/**
 * 移除会话
 *
 * 在对话流传输完毕后移除会话，避免创建的会话出现在用户的对话列表中
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function removeConversation(convId: string, refreshToken: string) {
  const { deviceId, token } = await acquireToken(refreshToken);
  const result = await axios.post(
    `https://stepchat.cn/api/proto.chat.v1.ChatService/DelChat`,
    {
      chatIds: [convId],
    },
    {
      headers: {
        Cookie: generateCookie(deviceId, token),
        "Oasis-Webid": deviceId,
        Referer: `https://stepchat.cn/chats/${convId}`,
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  checkResult(result, refreshToken);
}

/**
 * 同步对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param useSearch 是否开启联网搜索
 * @param retryCount 重试次数
 */
async function createCompletion(
  model = MODEL_NAME,
  messages: any[],
  refreshToken: string,
  useSearch = true,
  retryCount = 0
) {
  return (async () => {
    logger.info(messages);

    // 提取引用文件URL并上传step获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length
      ? await Promise.all(
        refFileUrls.map((fileUrl) => uploadFile(fileUrl, refreshToken))
      )
      : [];

    // 创建会话
    const convId = await createConversation("新会话", refreshToken);

    // 请求流
    const { deviceId, token } = await acquireToken(refreshToken);
    const result = await axios.post(
      `https://stepchat.cn/api/proto.chat.v1.ChatMessageService/SendMessageStream`,
      messagesPrepare(convId, messages, refs),
      {
        headers: {
          "Content-Type": "application/connect+json",
          Cookie: generateCookie(deviceId, token),
          "Oasis-Webid": deviceId,
          Referer: `https://stepchat.cn/chats/${convId}`,
          ...FAKE_HEADERS,
        },
        // 120秒超时
        timeout: 120000,
        validateStatus: () => true,
        responseType: "stream",
      }
    );

    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const answer = await receiveStream(model, convId, result.data);
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );

    // 异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
    removeConversation(convId, refreshToken).catch((err) => console.error(err));

    return answer;
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletion(
          model,
          messages,
          refreshToken,
          useSearch,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}

/**
 * 流式对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param useSearch 是否开启联网搜索
 * @param retryCount 重试次数
 */
async function createCompletionStream(
  model = MODEL_NAME,
  messages: any[],
  refreshToken: string,
  useSearch = true,
  retryCount = 0
) {
  return (async () => {
    logger.info(messages);

    // 提取引用文件URL并上传step获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length
      ? await Promise.all(
        refFileUrls.map((fileUrl) => uploadFile(fileUrl, refreshToken))
      )
      : [];

    // 创建会话
    const convId = await createConversation("新会话", refreshToken);

    // 请求流
    const { deviceId, token } = await acquireToken(refreshToken);
    const result = await axios.post(
      `https://stepchat.cn/api/proto.chat.v1.ChatMessageService/SendMessageStream`,
      messagesPrepare(convId, messages, refs),
      {
        headers: {
          "Content-Type": "application/connect+json",
          Cookie: generateCookie(deviceId, token),
          "Oasis-Webid": deviceId,
          Referer: `https://stepchat.cn/chats/${convId}`,
          ...FAKE_HEADERS,
        },
        // 120秒超时
        timeout: 120000,
        validateStatus: () => true,
        responseType: "stream",
      }
    );

    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    return createTransStream(model, convId, result.data, () => {
      logger.success(
        `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
      // 流传输结束后异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
      removeConversation(convId, refreshToken).catch((err) =>
        console.error(err)
      );
    });
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(
          model,
          messages,
          refreshToken,
          useSearch,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}

/**
 * 提取消息中引用的文件URL
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 */
function extractRefFileUrls(messages: any[]) {
  const urls = [];
  // 如果没有消息，则返回[]
  if (!messages.length) {
    return urls;
  }
  // 只获取最新的消息
  const lastMessage = messages[messages.length - 1];
  if (_.isArray(lastMessage.content)) {
    lastMessage.content.forEach(v => {
      if (!_.isObject(v) || !['file', 'image_url'].includes(v['type']))
        return;
      // step-free-api支持格式
      if (v['type'] == 'file' && _.isObject(v['file_url']) && _.isString(v['file_url']['url']))
        urls.push(v['file_url']['url']);
      // 兼容gpt-4-vision-preview API格式
      else if (v['type'] == 'image_url' && _.isObject(v['image_url']) && _.isString(v['image_url']['url']))
        urls.push(v['image_url']['url']);
    });
  }
  logger.info("本次请求上传：" + urls.length + "个文件");
  return urls;
}

/**
 * 消息预处理
 *
 * 由于接口只取第一条消息，此处会将多条消息合并为一条，实现多轮对话效果
 * user:旧消息1
 * assistant:旧消息2
 * user:新消息
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 */
function messagesPrepare(convId: string, messages: any[], refs: any[]) {
  // 先剔除所有的 base64 数据
  let validMessages = messages.map((message) => {
    if (Array.isArray(message.content)) {
      message.content = message.content.filter(v => {
        if (typeof v === 'object' && ['file', 'image_url'].includes(v['type'])) {
          // 如果内容是 base64 数据，就剔除
          return !util.isBASE64Data(v['url']);
        }
        // 如果不是 base64 数据，就保留
        return true;
      });
    }
    return message;
  });

  // 检查最新消息是否含有"type": "image_url"或"type": "file",如果有则注入消息
  let latestMessage = validMessages[validMessages.length - 1];
  let hasFileOrImage = Array.isArray(latestMessage.content)
    && latestMessage.content.some(v => (typeof v === 'object' && ['file', 'image_url'].includes(v['type'])));
  if (hasFileOrImage) {
    let newFileMessage = {
      "content": "以上为历史消息，关注以下用户发送的文件和消息",
      "role": "system"
    };
    validMessages.splice(validMessages.length - 1, 0, newFileMessage);
    logger.info("注入提升尾部文件注意力system prompt");
  } else {
    let newTextMessage = {
      "content": "以上为历史消息，关注以下用户消息",
      "role": "system"
    };
    validMessages.splice(validMessages.length - 1, 0, newTextMessage);
    logger.info("注入提升尾部消息注意力system prompt");
  }

  const content = validMessages.reduce((content, message) => {
    if (_.isArray(message.content)) {
      return message.content.reduce((_content, v) => {
        if (!_.isObject(v) || v["type"] != "text") return _content;
        return _content + ('user:' + v['text'] || "") + "\n";
      }, content);
    }
    return (content += `${message.role || "user"}:${message.content}\n`);
  }, "") + 'assistant:';

  logger.info("\n对话合并：\n" + content);
  const json = JSON.stringify({
    chatId: convId,
    messageInfo: {
      text: content,
      attachments: refs.length > 0 ? refs : undefined,
    },
  });
  const data = wrapData(json);
  return data;
}

/**
 * 检查请求结果
 *
 * @param result 结果
 * @param refreshToken 用于刷新access_token的refresh_token
 */
function checkResult(result: AxiosResponse, refreshToken: string) {
  if (!result.data) return null;
  const { code, message } = result.data;
  if (!_.isString(code)) return result.data;
  if (code == "unauthenticated") accessTokenMap.delete(refreshToken);
  throw new APIException(EX.API_REQUEST_FAILED, `[请求step失败]: ${message}`);
}

/**
 * 从流接收完整的消息内容
 *
 * @param model 模型名称
 * @param convId 会话ID
 * @param stream 消息流
 */
async function receiveStream(model: string, convId: string, stream: any) {
  return new Promise((resolve, reject) => {
    // 消息初始化
    const data = {
      id: convId,
      model,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp(),
    };
    let refContent = "";
    const parser = (buffer: Buffer) => {
      const result = _.attempt(() => JSON.parse(buffer.toString()));
      if (_.isError(result)) {
        logger.warn(`Error response: ${buffer.toString()}`);
        throw new Error(`Stream response invalid: ${result}`);
      }
      if (result.error && result.error.code)
        data.choices[0].message.content += `服务暂时不可用，第三方响应错误：[${result.error.code}] ${result.error.message}`;
      else if (result.pipelineEvent) {
        if (
          result.pipelineEvent.eventSearch &&
          result.pipelineEvent.eventSearch.results
        ) {
          refContent = result.pipelineEvent.eventSearch.results.reduce(
            (str, v) => {
              return (str += `${v.title}(${v.url})\n`);
            },
            ""
          );
        }
      } else if (result.textEvent && result.textEvent.text)
        data.choices[0].message.content += result.textEvent.text;
      else if (result.doneEvent) {
        data.choices[0].message.content += refContent
          ? `\n\n搜索结果来自：\n${refContent.replace(/\n$/, "")}`
          : "";
      }
    };
    let chunk = Buffer.from([]);
    let temp = Buffer.from([]);
    // 将流数据传到转换器
    stream.on("data", (buffer: Buffer) => {
      // 接收数据头
      chunk = Buffer.concat([temp, chunk, buffer]);
      if(chunk.length < 5)
        return;
      // 读取当前数据块大小
      const chunkSize = chunk.readUint32BE(1);
      // 根据当前大小接收完整数据块
      temp = chunk.subarray(chunkSize + 5);
      chunk = chunk.subarray(0, chunkSize + 5);
      if(chunk.length < chunkSize + 5)
        return;
      parser(chunk.subarray(5));
      chunk = Buffer.from([]);
    });
    stream.once("error", (err) => reject(err));
    stream.once("close", () => resolve(data));
  });
}

/**
 * 创建转换流
 *
 * 将流格式转换为gpt兼容流格式
 *
 * @param model 模型名称
 * @param convId 会话ID
 * @param stream 消息流
 * @param endCallback 传输结束回调
 */
function createTransStream(
  model: string,
  convId: string,
  stream: any,
  endCallback?: Function
) {
  // 消息创建时间
  const created = util.unixTimestamp();
  // 创建转换流
  const transStream = new PassThrough();
  !transStream.closed &&
    transStream.write(
      `data: ${JSON.stringify({
        id: convId,
        model,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
        created,
      })}\n\n`
    );
  const parser = (buffer: Buffer) => {
    const result = _.attempt(() => JSON.parse(buffer.toString()));
    if (_.isError(result))
      throw new Error(`Stream response invalid: ${result}`);
    if (result.error && result.error.code) {
      const data = `data: ${JSON.stringify({
        id: convId,
        model,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              content: `服务暂时不可用，第三方响应错误：[${result.error.code}] ${result.error.message}`,
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created,
      })}\n\n`;
      !transStream.closed && transStream.write(data);
      !transStream.closed && transStream.end("data: [DONE]\n\n");
      endCallback && endCallback();
    } else if (result.pipelineEvent) {
      if (
        result.pipelineEvent.eventSearch &&
        result.pipelineEvent.eventSearch.results
      ) {
        const refContent = result.pipelineEvent.eventSearch.results.reduce(
          (str, v) => {
            return (str += `检索 ${v.title}(${v.url}) ...\n`);
          },
          ""
        );
        const data = `data: ${JSON.stringify({
          id: convId,
          model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                content: `${refContent}\n`,
              },
              finish_reason: null,
            },
          ],
          created,
        })}\n\n`;
        !transStream.closed && transStream.write(data);
      }
    } else if (result.textEvent && result.textEvent.text) {
      const data = `data: ${JSON.stringify({
        id: convId,
        model,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { content: result.textEvent.text },
            finish_reason: null,
          },
        ],
        created,
      })}\n\n`;
      !transStream.closed && transStream.write(data);
    } else if (result.doneEvent) {
      const data = `data: ${JSON.stringify({
        id: convId,
        model,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created,
      })}\n\n`;
      !transStream.closed && transStream.write(data);
      !transStream.closed && transStream.end("data: [DONE]\n\n");
      endCallback && endCallback();
    }
  };
  let chunk = Buffer.from([]);
  let temp = Buffer.from([]);
  // 将流数据传到转换器
  stream.on("data", (buffer: Buffer) => {
    // 接收数据头
    chunk = Buffer.concat([temp, chunk, buffer]);
    if(chunk.length < 5)
      return;
    // 读取当前数据块大小
    const chunkSize = chunk.readUint32BE(1);
    // 根据当前大小接收完整数据块
    temp = chunk.subarray(chunkSize + 5);
    chunk = chunk.subarray(0, chunkSize + 5);
    if(chunk.length < chunkSize + 5)
      return;
    parser(chunk.subarray(5));
    chunk = Buffer.from([]);
  });
  stream.once(
    "error",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  stream.once(
    "close",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  return transStream;
}

/**
 * 构建数据包
 *
 * @param json 需要发送的JSON字符串
 */
function wrapData(json: string) {
  const data = Buffer.from(json);
  const buffer = Buffer.alloc(data.length + 5);
  buffer.set(data, 5);
  const dataView = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength
  );
  dataView.setUint8(0, 0x00);
  dataView.setUint32(1, data.length);
  return buffer;
}

/**
 * 生成cookie
 */
function generateCookie(deviceId: string, accessToken: string) {
  return [`Oasis-Token=${accessToken}`, `Oasis-Webid=${deviceId}`].join("; ");
}

/**
 * 预检查文件URL有效性
 *
 * @param fileUrl 文件URL
 */
async function checkFileUrl(fileUrl: string) {
  if (util.isBASE64Data(fileUrl)) return;
  const result = await axios.head(fileUrl, {
    timeout: 15000,
    headers: {
      UserAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    },
    validateStatus: () => true,
  });
  if (result.status >= 400)
    throw new APIException(
      EX.API_FILE_URL_INVALID,
      `File ${fileUrl} is not valid: [${result.status}] ${result.statusText}`
    );
  // 检查文件大小
  if (result.headers && result.headers["content-length"]) {
    const fileSize = parseInt(result.headers["content-length"], 10);
    if (fileSize > FILE_MAX_SIZE)
      throw new APIException(
        EX.API_FILE_EXECEEDS_SIZE,
        `File ${fileUrl} is not valid`
      );
  }
}

/**
 * 上传文件
 *
 * @param fileUrl 文件URL
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function uploadFile(fileUrl: string, refreshToken: string) {
  // 预检查远程文件URL可用性
  await checkFileUrl(fileUrl);

  let filename, fileData: Buffer, mimeType;
  // 如果是BASE64数据则直接转换为Buffer
  if (util.isBASE64Data(fileUrl)) {
    mimeType = util.extractBASE64DataFormat(fileUrl);
    const ext = mime.getExtension(mimeType);
    filename = `${util.uuid()}.${ext}`;
    fileData = Buffer.from(util.removeBASE64DataHeader(fileUrl), "base64");
  }
  // 下载文件到内存，如果您的服务器内存很小，建议考虑改造为流直传到下一个接口上，避免停留占用内存
  else {
    filename = path.basename(fileUrl);
    const queryIndex = filename.indexOf("?");
    if (queryIndex != -1) filename = filename.substring(0, queryIndex);
    ({ data: fileData } = await axios.get(fileUrl, {
      responseType: "arraybuffer",
      // 100M限制
      maxContentLength: FILE_MAX_SIZE,
      headers: {
        UserAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
      // 60秒超时
      timeout: 60000,
    }));
  }

  // 获取文件的MIME类型
  mimeType = mimeType || mime.getType(filename);
  // 上传文件到目标OSS
  const { deviceId, token } = await acquireToken(refreshToken);
  let result = await axios.request({
    method: "PUT",
    url: `https://stepchat.cn/api/storage?file_name=${filename}`,
    data: fileData,
    // 100M限制
    maxBodyLength: FILE_MAX_SIZE,
    // 60秒超时
    timeout: 60000,
    headers: {
      'Content-Type': mimeType,
      Cookie: generateCookie(deviceId, token),
      "Oasis-Webid": deviceId,
      Referer: "https://stepchat.cn/chats/new",
      "Stepchat-Meta-Width": "undefined",
      "Stepchat-Meta-Height": "undefined",
      "Stepchat-Meta-Size": `${fileData.byteLength}`,
      ...FAKE_HEADERS,
    },
    validateStatus: () => true,
  });
  const { id: fileId } = checkResult(result, refreshToken);

  let fileStatus, needFurtherCall = true;
  const startTime = util.unixTimestamp();
  while (needFurtherCall) {
    // 获取文件上传结果
    result = await axios.post(
      "https://stepchat.cn/api/proto.file.v1.FileService/GetFileStatus",
      {
        id: fileId,
      },
      {
        headers: {
          Cookie: generateCookie(deviceId, token),
          "Oasis-Webid": deviceId,
          Referer: "https://stepchat.cn/chats/new",
          ...FAKE_HEADERS,
        },
        timeout: 15000,
      }
    );
    ({ fileStatus, needFurtherCall } = checkResult(result, refreshToken));
    // 上传失败处理
    if ([12, 22, 59, 404].includes(fileStatus))
      throw new APIException(EX.API_FILE_UPLOAD_FAILED);
    // 上传超时处理
    if (util.unixTimestamp() - startTime > 60)
      throw new APIException(EX.API_FILE_UPLOAD_TIMEOUT);
  }
  await new Promise(resolve => setTimeout(resolve, 5000));

  return {
    attachmentType: mimeType,
    attachmentId: fileId,
    name: filename,
    width: "undefined",
    height: "undefined",
    size: `${fileData.byteLength}`,
  };
}

/**
 * Token切分
 *
 * @param authorization 认证字符串
 */
function tokenSplit(authorization: string) {
  return authorization.replace("Bearer ", "").split(",");
}

export default {
  createConversation,
  createCompletion,
  createCompletionStream,
  tokenSplit,
};
