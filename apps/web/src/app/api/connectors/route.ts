import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getUserConnectors, saveUserConnector, setUserActiveModel } from '@/lib/user-store';
import {
  getConnectorStatusList,
  ALLOWED_ENV_VARS,
  VALID_MODEL_IDS,
  VALID_REASONING_EFFORTS,
} from '@/lib/connectors-catalog';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: 请先登录后查看个人连接器' },
      { status: 401 }
    );
  }

  const userId = session.user.id;
  const connectors = getConnectorStatusList(userId);
  const userConfigs = getUserConnectors(userId);

  return NextResponse.json({
    success: true,
    total: connectors.length,
    connectedCount: connectors.filter((c) => c.status === 'connected').length,
    activeModelId: userConfigs.activeModelId,
    connectors,
  });
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: 请先登录后操作' },
        { status: 401 }
      );
    }

    const userId = session.user.id;
    const body = await req.json();

    // 1. 设置默认模型
    if (body.action === 'setDefaultModel' && typeof body.modelId === 'string') {
      if (!VALID_MODEL_IDS.has(body.modelId)) {
        return NextResponse.json(
          { success: false, error: `无效的模型 ID: ${body.modelId}` },
          { status: 400 }
        );
      }
      setUserActiveModel(userId, body.modelId);
      return NextResponse.json({
        success: true,
        message: `Default model switched to ${body.modelId}`,
        activeModelId: body.modelId,
        connectors: getConnectorStatusList(userId),
      });
    }

    // 2. 支持批量更新（针对带有 API Key, Base URL, Model Name, 思考深度 的连接器）
    if (body.action === 'saveConnectorConfig' && typeof body.envVar === 'string') {
      const {
        envVar,
        value,
        baseUrlEnvVar,
        baseUrl,
        modelNameEnvVar,
        modelName,
        reasoningEffortEnvVar,
        reasoningEffort,
      } = body;
      if (!ALLOWED_ENV_VARS.has(envVar)) {
        return NextResponse.json(
          { success: false, error: `不允许写入的配置键: ${envVar}` },
          { status: 400 }
        );
      }
      if (reasoningEffort !== undefined && !VALID_REASONING_EFFORTS.has(reasoningEffort)) {
        return NextResponse.json(
          { success: false, error: '无效的思考深度档位(仅支持 low/medium/high 或留空)' },
          { status: 400 }
        );
      }
      // Key 留空 = 本次不动凭证(只改 Base URL/模型标识/思考深度的元数据保存);
      // 空串写入会删键断开连接,绝不能被"只想调思考深度"的保存误触发
      if (typeof value === 'string' && value.trim()) {
        saveUserConnector(userId, envVar, value.trim());
      }
      if (baseUrlEnvVar && typeof baseUrl === 'string' && ALLOWED_ENV_VARS.has(baseUrlEnvVar)) {
        saveUserConnector(userId, baseUrlEnvVar, baseUrl.trim());
      }
      if (modelNameEnvVar && typeof modelName === 'string' && ALLOWED_ENV_VARS.has(modelNameEnvVar)) {
        saveUserConnector(userId, modelNameEnvVar, modelName.trim());
      }
      if (
        reasoningEffortEnvVar &&
        typeof reasoningEffort === 'string' &&
        ALLOWED_ENV_VARS.has(reasoningEffortEnvVar)
      ) {
        // '' = 清除连接器级配置(saveUserConnector 删键)→ 回落全局 env / 厂商缺省
        saveUserConnector(userId, reasoningEffortEnvVar, reasoningEffort.trim());
      }
      const userConfigs = getUserConnectors(userId);
      return NextResponse.json({
        success: true,
        message: `Connector ${envVar} updated successfully`,
        activeModelId: userConfigs.activeModelId,
        connectors: getConnectorStatusList(userId),
      });
    }

    // 3. 单个环境变量更新
    const { envVar, value } = body;
    if (!envVar || typeof value !== 'string') {
      return NextResponse.json({ success: false, error: 'Invalid parameters' }, { status: 400 });
    }
    if (!ALLOWED_ENV_VARS.has(envVar)) {
      return NextResponse.json(
        { success: false, error: `不允许写入的配置键: ${envVar}` },
        { status: 400 }
      );
    }

    saveUserConnector(userId, envVar, value.trim());
    const userConfigs = getUserConnectors(userId);

    return NextResponse.json({
      success: true,
      message: `Connector ${envVar} updated successfully`,
      activeModelId: userConfigs.activeModelId,
      connectors: getConnectorStatusList(userId),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}