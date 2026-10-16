/**
 * 工坊成品格式探测(纯函数,便于单测)。
 *
 * 驾驶舱整轮折叠以最终答复块为界;步数耗尽触发强制总结时最终答复是泛化
 * 散文,真正的成品清单留在中间 assistant step 上,会随过程区一起折进
 * 「任务过程 · N 项」(生产回归:开源雷达机会卡收尾不直接可见)。边界豁免
 * 判定只问「能否解析出任一成品格式」,不区分种类 —— 五种格式字段头互不
 * 相交(解析器测试双向锚定),逐一试探不会误判;article 先于 note 的顺序
 * 约束只影响卡片选型(CockpitView 渲染分支),不影响这里的布尔判定。
 */
import { parseArticlePackages } from './shared/article-package';
import { parseNotePackages } from './xhs/note-package';
import { parseNovelPackage } from './novel/novel-package';
import { parseOssOpportunities } from './oss_radar/opportunities';
import { parseTopicPicks } from './xhs/topic-picks';

/** 答复能否解析出任一工坊成品卡(选题/文章/笔记/开源机会/小说包) */
export function hasWorkshopDeliverable(answer: string): boolean {
  return (
    parseTopicPicks(answer).picks.length > 0 ||
    parseArticlePackages(answer).packages.length > 0 ||
    parseNotePackages(answer).packages.length > 0 ||
    parseOssOpportunities(answer).opportunities.length > 0 ||
    parseNovelPackage(answer) !== null
  );
}
