import { PassThrough } from "stream";
import path from "path";
import _ from "lodash";
import mime from "mime";
import axios, { AxiosResponse } from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from "eventsource-parser";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

// 模型名称
const MODEL_NAME = "step";
// access_token有效期
const ACCESS_TOKEN_EXPIRES = 900;
// 设备ID有效期
const DEVICE_ID_EXPIRES = 7200;
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
        Cookie: generationCookie(deviceId, token),
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
        Cookie: generationCookie(deviceId, token),
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
    // const refFileUrls = extractRefFileUrls(messages);
    // const refs = refFileUrls.length ? await Promise.all(refFileUrls.map(fileUrl => uploadFile(fileUrl, refreshToken))) : [];

    // 创建会话
    const convId = await createConversation("新会话", refreshToken);

    // 请求流
    const { deviceId, token } = await acquireToken(refreshToken);
    const result = await axios.post(
      `https://stepchat.cn/api/proto.chat.v1.ChatMessageService/SendMessageStream`,
      messagesPrepare(convId, messages),
      {
        headers: {
          "Content-Type": "application/connect+json",
          Cookie: generationCookie(deviceId, token),
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
    // const refFileUrls = extractRefFileUrls(messages);
    // const refs = refFileUrls.length
    //   ? await Promise.all(
    //       refFileUrls.map((fileUrl) => uploadFile(fileUrl, refreshToken))
    //     )
    //   : [];

    // 创建会话
    const convId = await createConversation("新会话", refreshToken);

    // 请求流
    const { deviceId, token } = await acquireToken(refreshToken);
    const result = await axios.post(
      `https://stepchat.cn/api/proto.chat.v1.ChatMessageService/SendMessageStream`,
      messagesPrepare(convId, messages),
      {
        headers: {
          "Content-Type": "application/connect+json",
          Cookie: generationCookie(deviceId, token),
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
  return messages.reduce((urls, message) => {
    if (_.isArray(message.content)) {
      message.content.forEach((v) => {
        if (!_.isObject(v) || !["file", "image_url"].includes(v["type"]))
          return;
        // step-free-api支持格式
        if (
          v["type"] == "file" &&
          _.isObject(v["file_url"]) &&
          _.isString(v["file_url"]["url"])
        )
          urls.push(v["file_url"]["url"]);
        // 兼容gpt-4-vision-preview API格式
        else if (
          v["type"] == "image_url" &&
          _.isObject(v["image_url"]) &&
          _.isString(v["image_url"]["url"])
        )
          urls.push(v["image_url"]["url"]);
      });
    }
    return urls;
  }, []);
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
function messagesPrepare(convId: string, messages: any[]) {
  const content = messages
    .reduce((content, message) => {
      if (_.isArray(message.content)) {
        return message.content
          .reduce((_content, v) => {
            if (!_.isObject(v) || v["type"] != "text") return _content;
            return _content + (v["text"] || "");
          }, content)
          .replace(/\n/g, "\\\\\\n");
      }
      return (content += `${message.role || "user"}:${message.content.replace(
        /\n/g,
        "\\\\\\n"
      )}\n`);
    }, "")
    .replace(/\n/g, "\\n");
  // 将消息转换为json
  const json = JSON.stringify({
    chatId: convId,
    messageInfo: {
      text: content,
    },
  });
  // 计算内容的字节数并转换为头部十六进制数据头然后尾部拼接json
  const data = `${generateDataHeader(
    Buffer.byteLength(json)
  ).toString()}${json}`;
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
      if (_.isError(result))
        throw new Error(`Stream response invalid: ${result}`);
      if (result.pipelineEvent) {
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
      }
      if (result.textEvent && result.textEvent.text)
        data.choices[0].message.content += result.textEvent.text;
      if (result.doneEvent) {
        data.choices[0].message.content += refContent
          ? `\n\n搜索结果来自：\n${refContent.replace(/\n$/, "")}`
          : "";
      }
    };
    // 将流数据传到转换器，每个buffer去除数据头5字节
    stream.on("data", (buffer: Buffer) => {
      const parts: Buffer[] = [];
      let length = 0;
      let sizeLength = 0;
      let i = 0;
      for (i = 0; i < buffer.byteLength; i++) {
        const byte = buffer.readUInt8(i);
        if (byte == 0x00) {
          if (length > 4) {
            const subBuffer = Buffer.alloc(length - (5 - sizeLength));
            const subStart = i - length + (5 - sizeLength);
            buffer.copy(subBuffer, 0, subStart, subStart + length + sizeLength);
            sizeLength = 0;
            parts.push(subBuffer);
          }
          sizeLength++;
          length = 0;
          continue;
        }
        length++;
      }
      if (length > 4) {
        const subBuffer = Buffer.alloc(length - (5 - sizeLength));
        const subStart = i - length + (5 - sizeLength);
        buffer.copy(subBuffer, 0, subStart, subStart + length + sizeLength);
        sizeLength = 0;
        parts.push(subBuffer);
      }
      parts.forEach((part) => parser(part));
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
    if (result.pipelineEvent) {
      if (
        result.pipelineEvent.eventSearch &&
        result.pipelineEvent.eventSearch.results
      ) {
        const refContent = result.pipelineEvent.eventSearch.results.reduce(
          (str, v) => {
            return (str += `检索 ${v.title}(${v.url}) ...\n`);
          },
          ""
        )
        const data = `data: ${JSON.stringify({
          id: convId,
          model,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0, delta: {
                content: `${refContent}\n`
              }, finish_reason: null
            }
          ],
          created
        })}\n\n`;
        !transStream.closed && transStream.write(data);
      }
    }
    if (result.textEvent && result.textEvent.text) {
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
    }
    if (result.doneEvent) {
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
  // 将流数据传到转换器，每个buffer去除数据头5字节
  stream.on("data", (buffer: Buffer) => {
    const parts: Buffer[] = [];
    let length = 0;
    let sizeLength = 0;
    let i = 0;
    for (i = 0; i < buffer.byteLength; i++) {
      const byte = buffer.readUInt8(i);
      if (byte == 0x00) {
        if (length > 4) {
          const subBuffer = Buffer.alloc(length - (5 - sizeLength));
          const subStart = i - length + (5 - sizeLength);
          buffer.copy(subBuffer, 0, subStart, subStart + length + sizeLength);
          sizeLength = 0;
          parts.push(subBuffer);
        }
        sizeLength++;
        length = 0;
        continue;
      }
      length++;
    }
    if (length > 4) {
      const subBuffer = Buffer.alloc(length - (5 - sizeLength));
      const subStart = i - length + (5 - sizeLength);
      buffer.copy(subBuffer, 0, subStart, subStart + length + sizeLength);
      sizeLength = 0;
      parts.push(subBuffer);
    }
    parts.forEach((part) => parser(part));
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
 * 生成数据头
 */
function generateDataHeader(byteLength: number) {
  const buffer = Buffer.alloc(5);
  buffer.writeUInt32BE(byteLength, 1);
  return buffer;
}

/**
 * 生成cookie
 */
function generationCookie(deviceId: string, accessToken: string) {
  return [`Oasis-Token=${accessToken}`, `Oasis-Webid=${deviceId}`].join("; ");
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
