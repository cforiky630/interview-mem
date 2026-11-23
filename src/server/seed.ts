import { getDb } from "@/db";
import { decks, questions } from "@/db/schema";
import { contentHash } from "./crypto";
import { ensureWorkspace, nextQuestionBaseMs } from "./workspace";
import { and, eq } from "drizzle-orm";

const samples = [
  {
    title: "JavaScript 核心",
    description:
      "覆盖事件循环、作用域闭包与防抖节流等高频底层机制，配齐示例与追问，帮你从背概念转向讲清因果。",
    color: "sage",
    items: [
      {
        title: "JavaScript 的事件循环是怎样工作的？",
        tags: ["JavaScript", "高频", "异步"],
        answer:
          "---\ntags:\n  - JavaScript\n  - 高频\n  - 异步\naliases:\n  - Event Loop\n  - 宏任务与微任务\ndifficulty: 高频核心\n---\n\n## 一句话讲清\n事件循环用来协调单线程调用栈与各类异步任务队列：同步代码优先清空调用栈，随后耗尽微任务队列，再在合适时机触发渲染并取出下一轮宏任务。\n\n## 完整执行顺序\n1. 执行当前宏任务中的同步代码，函数逐层压栈并弹出。\n2. 当前调用栈清空后进入微任务检查点（Microtask Checkpoint），依次执行队列里全部微任务，过程中新产生的微任务也在本轮一并清空。\n3. 浏览器评估是否到达刷新周期，按需执行重排重绘与 `requestAnimationFrame` 回调。\n4. 从任务队列中取出下一个到期宏任务，开启新一轮循环。\n\n常见微任务包括 `Promise.then/catch/finally`、`queueMicrotask` 和 `MutationObserver`；常见宏任务包括脚本整体、`setTimeout`、`setInterval` 与 I/O 事件回调。定时器的延迟时间仅代表“最早可被调度的下限”。\n\n```javascript\nconsole.log('A');\nsetTimeout(() => console.log('B'), 0);\nPromise.resolve().then(() => console.log('C'));\nconsole.log('D');\n// 实际输出：A → D → C → B\n```\n\n> 面试表达建议：先用三步概括（调用栈 → 清空微任务 → 渲染/下一宏任务），再顺手画出上述执行顺序对比。\n\n### 面试追问\n**Q：如果微任务里不断递归注册新的微任务，会发生什么？**\n**A：** 浏览器会一直留在当前微任务检查点中无法进入渲染阶段与下一轮宏任务，最终表现为页面卡死、点击无响应。\n\n**Q：`async/await` 中的代码在事件循环里属于哪一类？**\n**A：** `await` 右侧表达式及之前的同步部分立即按同步代码执行；`await` 之后剩余的函数体则相当于包装进 `Promise.then`，作为微任务等待状态敲定后执行。",
      },
      {
        title: "闭包是什么？它有哪些实际用途？",
        tags: ["JavaScript", "作用域"],
        answer:
          "## 核心定义\n闭包是**函数与其词法环境（Lexical Environment）的组合**。当内部函数在外部函数执行结束后依然被持有，它仍能访问声明时所在作用域链上的自由变量。\n\n```javascript\nfunction createCounter() {\n  let count = 0;\n  return () => ++count;\n}\nconst next = createCounter();\nnext(); // 1\nnext(); // 2\n```\n\n## 常见工程用途\n- **状态封装与私有变量**：只暴露受控接口（例如计数器、状态机），避免全局变量污染。\n- **函数工厂与柯里化**：预先固化部分参数（如按日志级别生成专用上报函数）。\n- **Hooks 与回调上下文保留**：事件监听器、定时器回调以及防抖节流函数中持久保存 `timer` 或最新配置引用。\n\n## 避坑提醒\n闭包本身**不等于内存泄漏**。只有当长生命周期对象意外持有了本该释放的大对象（例如忘记解绑的事件监听器或未清理的缓存 Map）时，才会造成内存无法被 GC 回收。\n\n### 面试追问\n**Q：在现代 React Hooks 里常听说“闭包陷阱（Stale Closure）”，原因是什么？**\n**A：** 当 `useEffect` 或事件回调省略了必要依赖却引用了旧一次渲染时的 `state`/`props`，函数闭包锁住的仍是当时渲染快照中的值，可通过完善依赖数组或使用 `useRef` / 函数式更新解决。",
      },
      {
        title: "防抖和节流分别适合什么场景？",
        tags: ["JavaScript", "性能"],
        answer:
          "## 核心区别\n- **防抖（Debounce）**：连续触发时不断重置计时器，只在上一次触发停止超过指定间隔后执行一次——强调**“停下来再做”**。\n- **节流（Throttle）**：无论触发多密集，在每个固定时间窗口内最多只执行一次——强调**“按节奏稀释”**。\n\n```javascript\nfunction debounce(fn, delay) {\n  let timer;\n  return function (...args) {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn.apply(this, args), delay);\n  };\n}\n```\n\n## 典型选型对比\n- **适合防抖**：搜索框自动补全请求、表单字段异步校验、`resize` 结束后重新计算布局。\n- **适合节流**：页面滚动加载判断、拖拽/鼠标移动坐标采样、按钮高频防连点（或首调执行模式）。\n\n## 实战细节\n面试作答时补上一句工程习惯会很加分：在组件卸载时调用 `cancel()` 清理尚未触发的定时器，并注意保留原始 `this` 指向与最后一次触发参数。\n\n### 面试追问\n**Q：搜索建议请求不仅用了防抖，还经常会配合什么手段防乱序？**\n**A：** 配合 `AbortController` 取消上一次尚未返回的请求，或者用递增请求序号校验响应时序，防止先发出的慢请求后返回覆盖最新搜索结果。",
      },
    ],
  },
  {
    title: "React 与工程实践",
    description:
      "拆解 Diff 复用依据、副作用生命周期与清理心智模型，梳理可直接在项目追问中复用的回答结构。",
    color: "blue",
    items: [
      {
        title: "为什么 React 列表需要稳定的 key？",
        tags: ["React", "高频"],
        answer:
          "## 核心作用\n`key` 是 React 协调（Reconciliation）阶段识别**同一父节点下兄弟元素身份**的唯一凭证。有了稳定 `key`，React 在列表发生重排、头部插入或中间删除时，才能精确复用原有 Fiber 节点、真实 DOM 以及组件内部状态。\n\n## 用数组下标 `index` 的隐患\n- 若在列表头部插入或中间删除元素，后续所有项的下标都会整体偏移，导致原本绑在 A 上的输入框内容、选中态或异步状态错误留在新数据 B 上。\n- 同时会让原本只需移动位置的节点被误判为“属性全变”，产生不必要的 DOM 更新开销。\n\n```tsx\nitems.map((item) => (\n  <TodoRow key={item.id} item={item} />\n));\n```\n\n## 使用原则\n- `key` 只需在**当前兄弟节点之间**唯一且跨渲染稳定，首选后端主键或前端稳定 ID。\n- 禁止在 `render` 中现用 `Math.random()` 生成，否则每次渲染都会强制卸载并重建全部子节点。\n\n### 面试追问\n**Q：在什么场景下可以刻意修改某个组件的 `key`？**\n**A：** 当切换展示另一条完全不同的数据时（例如从用户 A 的资料编辑页切到用户 B），主动将 `key` 绑定为 `userId`，可以借 React 自动卸载并重置所有表单与局部状态，替代繁琐的手动 `useEffect` 重置逻辑。",
      },
      {
        title: "useEffect 的依赖数组应该怎么理解？",
        tags: ["React", "Hooks"],
        answer:
          "## 正确的心智模型\n不要把 `useEffect` 等同于 class 组件里的挂载/更新生命周期，而应把它看作：**让当前组件与外部系统（网络订阅、定时器、第三方 DOM 实例、浏览器事件）保持同步的机制**。\n\n## 依赖数组与清理时机\n- **依赖数组**：声明 Effect 内部读取的所有响应式值（`props`、`state` 以及组件体内推导出的变量/函数）。\n- **同步循环**：每当依赖发生变化，React 会先运行**上一次渲染返回的清理函数（cleanup）**以断开旧同步，再使用新值运行新的 Effect。\n\n```tsx\nuseEffect(() => {\n  const connection = connect(roomId);\n  return () => connection.disconnect();\n}, [roomId]);\n```\n\n## 常见误区澄清\n传入空数组 `[]` 只代表 Effect 不依赖任何响应式状态，并不等价于“保证绝对只运行一次”。开发环境开启 `StrictMode` 时，React 会刻意执行 `setup → cleanup → setup` 的双重检查，用来提前暴露漏写清理逻辑造成的连接泄露。\n\n### 面试追问\n**Q：如何避免把组件每次渲染都重建的普通对象或函数放进依赖数组导致死循环？**\n**A：** 若对象/函数仅在 Effect 内使用，直接移入 `useEffect` 内部声明；若确实来自组件其它部分，可在外层用 `useCallback`/`useMemo` 稳定引用，或梳理后将其降为无需依赖 `state` 的纯函数或使用 `useEffectEvent` 模式隔离非响应式读取。",
      },
    ],
  },
  {
    title: "网络与数据库",
    description:
      "打通浏览器缓存协商链路与存储索引底层结构，串联一次典型后端/全栈面试的高频考点与权衡取舍。",
    color: "sand",
    items: [
      {
        title: "HTTP 缓存中，强缓存与协商缓存有什么区别？",
        tags: ["网络", "HTTP"],
        answer:
          "## 一句话区分\n- **强缓存（新鲜缓存）**：命中时浏览器**不发网络请求**，直接从本地缓存复用资源（常见 `200 (from memory/disk cache)`）。\n- **协商缓存（条件请求）**：本地副本已过期或需要校验时，浏览器向服务端发送带验证头的请求，由服务端判断资源是否变更。\n\n## 关键控制头\n- **强缓存**：优先由 `Cache-Control: max-age=3600` 控制有效秒数，老协议头 `Expires` 依赖客户端本地时钟精度已退居备选。\n- **协商缓存**：服务端下发 `ETag`（内容摘要指纹，优先级更高）或 `Last-Modified`（修改时间戳）；下次请求由客户端携带 `If-None-Match` 或 `If-Modified-Since`，未变更时返回 `304 Not Modified` 仅传响应头。\n\n## 高频概念辨析\n- `no-cache`：**不是**“禁止缓存”，而是“允许缓存存储，但每次复用前都必须向源站发送条件请求验证”。\n- `no-store`：才是真正禁止在本地磁盘或代理节点持久化存储任何响应副本。\n\n### 面试追问\n**Q：现代前端打包发布后，HTML 入口文件与带哈希的 JS/CSS 静态资源通常如何搭配缓存策略？**\n**A：** `index.html` 采用 `Cache-Control: no-cache`（每次走协商缓存快速确认是否有新版），而文件名自带内容哈希的 JS/CSS/图片采用 `Cache-Control: public, max-age=31536000, immutable` 拉满强缓存，版本升级直接变更文件名 URL。",
      },
      {
        title: "数据库索引为什么常用 B+ 树？",
        tags: ["数据库", "索引"],
        answer:
          "## 核心优势\n1. **高扇出、树高低**：B+ 树的非叶子节点只存放索引键和子节点指针，不携带完整行记录，使得单页（如 InnoDB 默认 16KB 页）能容纳海量分支，千万级数据通常仅需 **3~4 层树高**即可定位，显著降低磁盘 I/O 次数。\n2. **天生支持范围扫描与排序**：全部数据记录按顺序挂载在叶子节点，且叶节点之间通过双向链表串联，执行 `BETWEEN`、`>`、`ORDER BY` 时只需定位起点后顺序遍历链表。\n3. **查询耗时更稳定**：每次查找都必须走到叶子节点，不同键值的检索延迟几乎一致。\n\n## 与其他结构的对比\n- **哈希索引**：单点等值查询近似 O(1)，但无法支持范围查找、排序与最左前缀匹配。\n- **二叉树 / 红黑树**：扇出低（每节点仅两叉），百万数据树高达到 20+ 层，磁盘随机寻址不可接受。\n\n## 工程取舍与原则\n索引会额外占用磁盘与内存页空间，并在 `INSERT`/`UPDATE`/`DELETE` 时增加 B+ 树页分裂与维护开销；复合索引应遵循**最左前缀原则**，把高区分度等值列放在前面、范围列放在后面，最终以 `EXPLAIN` 执行计划为准。\n\n### 面试追问\n**Q：什么是 InnoDB 中的“回表”？如何避免回表？**\n**A：** 使用普通二级索引查询时，若索引页只存储了索引列与主键值，就需要拿主键值再到聚簇索引查一遍完整行记录，这就是“回表”。将查询所需全部列包含进联合索引形成**覆盖索引（Using index）**，即可免去回表开销。",
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
    const baseMs = await nextQuestionBaseMs(tx, userId);
    let insertSeq = 0;
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
        const ts = new Date(baseMs + insertSeq++);
        await tx.insert(questions).values({
          id: crypto.randomUUID(),
          deckId,
          ownerId: userId,
          title: q.title,
          answer: q.answer,
          tags: q.tags,
          sourceText: q.title + "\n" + q.answer,
          contentHash: contentHash(q.title, q.answer),
          createdAt: ts,
          updatedAt: ts,
        });
        added++;
      }
    }
    return { added };
  });
}
