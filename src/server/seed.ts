import { getDb } from "@/db";
import { decks, questions } from "@/db/schema";
import { contentHash } from "./crypto";
import { ensureWorkspace } from "./workspace";
import { and, eq } from "drizzle-orm";

const samples = [
  {
    title: "JavaScript 核心",
    description: "从语言机制到自己的理解，把基础讲清楚。",
    color: "sage",
    items: [
      {
        title: "JavaScript 的事件循环是怎样工作的？",
        tags: ["JavaScript", "高频", "异步"],
        answer:
          "## 一句话理解\n事件循环协调调用栈与任务队列，让单线程 JavaScript 能处理异步工作。\n\n## 执行顺序\n1. 当前任务中的同步代码先在调用栈执行。\n2. 当前任务结束、调用栈清空后，执行微任务检查点，持续清空微任务队列。\n3. 浏览器在合适的时机执行渲染，再选取下一个任务。\n\nPromise 回调和 `queueMicrotask` 通常属于微任务，`setTimeout` 回调属于任务。计时器的延时表示最早可执行时间，并不保证准点运行。\n\n```javascript\nconsole.log('A');\nsetTimeout(() => console.log('B'), 0);\nPromise.resolve().then(() => console.log('C'));\nconsole.log('D');\n// A → D → C → B\n```\n\n> 面试表达：先区分同步执行、微任务检查点与后续任务，再结合代码说明。",
      },
      {
        title: "闭包是什么？它有哪些实际用途？",
        tags: ["JavaScript", "作用域"],
        answer:
          "闭包是函数与其词法环境的组合。即使外层函数已经返回，内部函数仍可以访问创建时所在作用域中的变量。\n\n```javascript\nfunction createCounter() {\n  let count = 0;\n  return () => ++count;\n}\nconst next = createCounter();\nnext(); // 1\nnext(); // 2\n```\n\n## 常见用途\n- 保存函数调用之间的私有状态。\n- 实现柯里化、回调与函数工厂。\n- 在事件处理器中访问上下文。\n\n闭包不等于内存泄漏；只有不再需要的数据仍被可达引用保留，才需要关注释放。",
      },
      {
        title: "防抖和节流分别适合什么场景？",
        tags: ["JavaScript", "性能"],
        answer:
          "**防抖**：连续触发时重新计时，等操作停止一段时间再执行。适合搜索框请求、输入校验。\n\n**节流**：限制一段时间内的执行频率。适合滚动监听、拖动反馈。\n\n```javascript\nfunction debounce(fn, delay) {\n  let timer;\n  return function (...args) {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn.apply(this, args), delay);\n  };\n}\n```\n\n面试时还可以说明首尾执行策略，以及组件卸载时取消未执行任务。",
      },
    ],
  },
  {
    title: "React 与工程实践",
    description: "理解渲染、状态与工程中的取舍。",
    color: "blue",
    items: [
      {
        title: "为什么 React 列表需要稳定的 key？",
        tags: ["React", "高频"],
        answer:
          "`key` 帮助 React 在同一父节点下识别列表项的身份，让重排、插入和删除时的状态与元素正确关联。\n\n使用数组下标时，列表头部插入新项会让原有位置对应到不同数据，可能导致输入状态等错位。\n\n```tsx\nitems.map(item => (\n  <TodoRow key={item.id} item={item} />\n))\n```\n\n`key` 在兄弟节点之间需要唯一且稳定。不要在每次渲染时随机生成，也不要把它当作传入组件的普通 prop。",
      },
      {
        title: "useEffect 的依赖数组应该怎么理解？",
        tags: ["React", "Hooks"],
        answer:
          "Effect 用于将组件与外部系统同步，例如事件订阅、连接和非 React 控件。\n\n依赖数组列出 Effect 读取的响应式值。值变化时，React 先执行上一次清理，再运行新的 Effect。\n\n```tsx\nuseEffect(() => {\n  const connection = connect(roomId);\n  return () => connection.disconnect();\n}, [roomId]);\n```\n\n空数组表示没有响应式依赖，并不意味着开发环境下只执行一次。开发模式的 Strict Mode 可以额外执行一次 setup/cleanup 来帮助发现清理问题。",
      },
    ],
  },
  {
    title: "网络与数据库",
    description: "串联一次请求背后的基础知识。",
    color: "sand",
    items: [
      {
        title: "HTTP 缓存中，强缓存与协商缓存有什么区别？",
        tags: ["网络", "HTTP"],
        answer:
          "**新鲜缓存（通常称为强缓存）**允许客户端在响应仍新鲜时直接复用，常通过 `Cache-Control: max-age` 控制。\n\n**条件请求（通常称为协商缓存）**会向服务器确认资源是否变化，例如携带 `If-None-Match`。未变化时服务器可返回 `304`，客户端复用已有响应体。\n\n- `no-cache`：允许存储，但复用前需要验证。\n- `no-store`：要求不要存储响应。\n- `ETag` 是验证器，`If-None-Match` 是条件请求头。\n\n面试时注意：`no-cache` 不能直接解释成“完全不缓存”。",
      },
      {
        title: "数据库索引为什么常用 B+ 树？",
        tags: ["数据库", "索引"],
        answer:
          "B+ 树通常具有较高扇出，能以较少层级组织大量索引条目，减少查找所需的页面访问。\n\n有序叶节点便于范围扫描与排序相关操作。和哈希索引相比，它更适合同时支持等值和范围查询。\n\n## 需要补充的取舍\n- 索引会占用空间，并增加写入维护成本。\n- 复合索引的列顺序应结合查询条件与排序需求。\n- 是否使用索引最终需要查看执行计划，不能只根据 SQL 外观判断。",
      },
    ],
  },
];
export async function seedSamples(userId: string) {
  await ensureWorkspace(userId);
  const db = await getDb();
  return db.transaction(async (tx) => {
    // Serialize sample loading for this user so double clicks do not duplicate it.
    await tx
      .select()
      .from(decks)
      .where(eq(decks.ownerId, userId))
      .for("update");
    const existing = await tx
      .select()
      .from(decks)
      .where(
        and(
          eq(decks.ownerId, userId),
          eq(decks.title, "JavaScript 核心 · 示例"),
        ),
      );
    if (existing.length) return { added: 0 };
    let added = 0;
    for (const sample of samples) {
      const deckId = crypto.randomUUID();
      await tx.insert(decks).values({
        id: deckId,
        ownerId: userId,
        title: sample.title + " · 示例",
        description: sample.description,
        color: sample.color,
      });
      for (const q of sample.items) {
        await tx.insert(questions).values({
          id: crypto.randomUUID(),
          deckId,
          title: q.title,
          answer: q.answer,
          tags: q.tags,
          sourceText: q.title + "\n" + q.answer,
          contentHash: contentHash(q.title, q.answer),
        });
        added++;
      }
    }
    return { added };
  });
}
