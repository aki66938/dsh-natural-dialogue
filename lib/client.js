window.__ModuleLoader__.load({
  id: 'dsh-natural-dialogue',
  factory: (require) => {
    const React = require('react'),
      { createElement: h, useState, useEffect } = React
    const API = '/natural-dialogue/api/'
    async function request(route, body) {
      const r = await fetch(API + route, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const text = await r.text()
      if (!text.trim())
        throw Error(
          '自然对话接口返回空响应（HTTP ' + r.status + '），请重新打开设置页；仍失败时重启 DSH。',
        )
      let j
      try {
        j = JSON.parse(text)
      } catch {
        throw Error('自然对话接口返回格式异常（HTTP ' + r.status + '）')
      }
      if (!r.ok || !j.ok) throw Error(j.error || '请求失败')
      return j
    }
    const css =
      '.nd{max-width:800px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary)}.nd section{border:1.5px dashed color-mix(in srgb,currentColor 35%,transparent);border-radius:10px;padding:16px}.nd h3{font-size:14px;margin:0 0 12px}.nd label{display:block;margin:10px 0;font-size:13px}.nd textarea,.nd input:not([type=checkbox]),.nd select{display:block;box-sizing:border-box;width:100%;padding:7px;background:transparent;color:inherit;border:1px solid #8886;border-radius:6px}.nd textarea{min-height:72px}.nd button{margin:6px 8px 0 0;padding:6px 12px;border:1px solid #8887;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.nd small{display:block;opacity:.7;line-height:1.6}.nd article{border-top:1px solid #8884;padding:12px 0;white-space:pre-wrap;overflow-wrap:anywhere}.nd .error{color:#d75d4c}.nd pre{white-space:pre-wrap;font-size:12px}'
    function Settings() {
      const [data, setData] = useState(null),
        [cfg, setCfg] = useState(null),
        [scope, setScope] = useState(''),
        [items, setItems] = useState([]),
        [message, setMessage] = useState(''),
        [busy, setBusy] = useState(false),
        [editing, setEditing] = useState(null),
        [correction, setCorrection] = useState(''),
        [preview, setPreview] = useState(false)
      const dirty = !!cfg && JSON.stringify(cfg) !== JSON.stringify(data?.config)
      useEffect(() => {
        if (!dirty) return
        const warn = (e) => {
          e.preventDefault()
          e.returnValue = ''
        }
        window.addEventListener('beforeunload', warn)
        return () => window.removeEventListener('beforeunload', warn)
      }, [dirty])
      const load = async (preserveDraft = false) => {
        try {
          const j = await request('status')
          if (preserveDraft) {
            setData((previous) => ({
              ...j,
              config: previous?.config ?? j.config,
              configRevision: previous?.configRevision ?? j.configRevision,
            }))
            setCfg((previous) => previous ?? j.config)
          } else {
            setData(j)
            setCfg(j.config)
          }
          setScope((s) => s || j.scopes[0]?.namespace || '')
        } catch (e) {
          setMessage(e.message)
        }
      }
      useEffect(() => {
        load()
      }, [])
      useEffect(() => {
        if (!scope) {
          setItems([])
          return
        }
        let live = true
        request('memories?scope=' + encodeURIComponent(scope))
          .then((j) => {
            if (live) setItems(j.items)
          })
          .catch((e) => {
            if (live) setMessage(e.message)
          })
        return () => {
          live = false
        }
      }, [scope, data])
      const update = (group, key, value) =>
        setCfg((c) => {
          const n = JSON.parse(JSON.stringify(c))
          if (group) n[group][key] = value
          else n[key] = value
          return n
        })
      const run = async (fn) => {
        setBusy(true)
        try {
          await fn()
        } catch (e) {
          setMessage(e.message)
        } finally {
          setBusy(false)
        }
      }
      const field = (label, group, key, type = 'text', hint = '') =>
        h(
          'label',
          null,
          label,
          type === 'checkbox'
            ? h('input', {
                type,
                checked: !!(group ? cfg[group][key] : cfg[key]),
                onChange: (e) => update(group, key, e.target.checked),
              })
            : type === 'textarea'
              ? h('textarea', {
                  value: cfg[group][key],
                  onChange: (e) => update(group, key, e.target.value),
                })
              : h('input', {
                  type,
                  value: (group ? cfg[group][key] : cfg[key]) ?? '',
                  onChange: (e) =>
                    update(group, key, type === 'number' ? Number(e.target.value) : e.target.value),
                }),
          hint ? h('small', null, hint) : null,
        )
      if (!cfg)
        return h(
          'div',
          { className: 'nd' },
          h('p', { role: 'status' }, message || '正在读取自然对话配置…'),
          message ? h('button', { disabled: busy, onClick: () => run(load) }, '重新加载') : null,
        )
      return h(
        'div',
        { className: 'nd' },
        h('style', null, css),
        h('h2', null, '自然对话'),
        h(
          'small',
          null,
          '第一次使用：选择一个人格 → 按喜好调整 → 保存设置。记忆选项保持默认即可。',
        ),
        dirty ? h('p', { role: 'status' }, '有未保存的修改') : null,
        h(
          'section',
          null,
          h('h3', null, '生效范围'),
          field('启用自然对话', null, 'enabled', 'checkbox'),
          h(
            'label',
            null,
            '记忆共享范围',
            h(
              'select',
              { value: cfg.scope, onChange: (e) => update(null, 'scope', e.target.value) },
              [
                ['workspace', '同一工作区共享记忆（默认）'],
                ['sessions', '仅指定会话，各自独立记忆'],
                ['profile', '全部工作区共享记忆（当前插件库）'],
              ].map(([value, label]) => h('option', { value, key: value }, label)),
            ),
          ),
          h(
            'label',
            null,
            '指定会话 ID，每行一个',
            h('textarea', {
              value: cfg.sessions.join('\n'),
              onChange: (e) => update(null, 'sessions', e.target.value.split('\n').filter(Boolean)),
            }),
          ),
          h(
            'small',
            null,
            '默认排除养鱼会话、whale-work 目录和子代理。开启 profile 共享会让不同项目互相召回记忆。',
          ),
        ),
        h(
          'section',
          null,
          h('h3', null, '人格'),
          h(
            'small',
            null,
            '选择方案会替换整份人格草稿，保存后生效；不会删除记忆。你也可以完全自己定义。',
          ),
          ...(data?.personas ?? []).map((p) =>
            h(
              'article',
              { key: p.id },
              h('strong', null, p.title),
              h('small', null, p.summary),
              h(
                'button',
                {
                  disabled: busy,
                  onClick: () => {
                    if (dirty && !window.confirm('替换当前人格草稿？其他设置和记忆保持原样。'))
                      return
                    setCfg((c) => ({
                      ...c,
                      persona: {
                        ...JSON.parse(JSON.stringify(p.persona)),
                        name: c.persona.name || p.persona.name,
                      },
                    }))
                    setMessage('已选择「' + p.title + '」，保存后生效')
                  },
                },
                '使用「' + p.title + '」',
              ),
            ),
          ),
          h('h3', null, '当前人格：' + (cfg.persona.name || '未命名')),
          field('名字', 'persona', 'name'),
          field('身份背景', 'persona', 'identity', 'textarea'),
          field('人格设定', 'persona', 'personality', 'textarea'),
          field('行为风格', 'persona', 'behavior', 'textarea'),
          field('表达风格', 'persona', 'style', 'textarea'),
          h(
            'details',
            null,
            h('summary', null, '自定义补充（可选）'),
            field('关系补充', 'persona', 'relationship', 'textarea'),
            field('兴趣补充', 'persona', 'interests', 'textarea'),
            field('价值取向', 'persona', 'values', 'textarea'),
            field('不喜欢的事', 'persona', 'dislikes', 'textarea'),
            field(
              '对话示例',
              'persona',
              'examples',
              'textarea',
              '写几组你希望的接话方式，示例不作为真实经历记忆，也不要求模型照抄。',
            ),
          ),
          h(
            'details',
            null,
            h('summary', null, '表达与临时风格'),
            h(
              'button',
              {
                disabled: busy || !data?.defaults,
                onClick: () => update('persona', 'style', data.defaults.persona.style),
              },
              '恢复默认表达',
            ),
            h('button', { onClick: () => setPreview(!preview) }, '查看配置预览（不调用模型）'),
            preview
              ? h(
                  'pre',
                  null,
                  '人格：' +
                    cfg.persona.name +
                    '\n性格：' +
                    cfg.persona.personality +
                    '\n兴趣：' +
                    cfg.persona.interests +
                    '\n表达：' +
                    cfg.persona.style +
                    '\n\n保存后在聊天中试着说：今天有点累，不想干活。\n这不是生成效果预览，实际回复由当前模型产生。',
                )
              : null,
            h(
              'details',
              null,
              h('summary', null, '偶尔变化的语气'),
              h(
                'label',
                null,
                '备用语气，每行一条',
                h('textarea', {
                  value: cfg.persona.alternates.join('\n'),
                  onChange: (e) => update('persona', 'alternates', e.target.value.split('\n')),
                }),
              ),
              field('备用语气概率（0–1）', 'persona', 'probability', 'number'),
              h('small', null, '备用语气仅在闲聊时偶尔使用。希望口吻稳定时设为 0。'),
            ),
          ),
        ),
        h(
          'section',
          null,
          h('h3', null, '独立回复生成'),
          field('启用独立 Replyer', 'replyer', 'enabled', 'checkbox'),
          (data?.status?.replyer?.lastEvent ?? data?.replyerEvents?.at(-1))
            ? h(
                'small',
                null,
                '最近回复：' +
                  ((data.status?.replyer?.lastEvent ?? data.replyerEvents.at(-1)).reason ===
                  'rendered'
                    ? '已独立生成'
                    : '保留原结果，原因见运行状态'),
              )
            : null,
          data?.status?.replyer
            ? h(
                'small',
                null,
                '本次启动已生成 ' +
                  data.status.replyer.rendered +
                  ' 次，回退 ' +
                  data.status.replyer.fallback +
                  ' 次。可在运行状态查看具体原因。',
              )
            : null,
          h(
            'small',
            null,
            'DSH 先完成判断和工具操作，再由独立模型调用组织最终发言。跟随当前会话模型，每次最终回复通常增加一次调用与等待时间；失败时回退原结果。JSON 等精确输出保留原样。',
          ),
        ),
        h(
          'section',
          null,
          h('h3', null, '记忆与学习'),
          field('回复前规划', 'planner', 'enabled', 'checkbox'),
          field('启用长期记忆', 'memory', 'enabled', 'checkbox'),
          field('自动整理新对话', 'memory', 'automatic', 'checkbox'),
          field('事实记忆需人工确认', 'memory', 'reviewFacts', 'checkbox'),
          field('学习用户表达', 'learning', 'enabled', 'checkbox'),
          field('自动采用学到的表达', 'learning', 'autoApprove', 'checkbox'),
          h(
            'small',
            null,
            '通常每轮一次规划调用和一次记忆整理调用，失败重试会增加调用，使用你已有的 DSH 模型服务，会增加用量。只学习保存设置后产生的新对话，不扫描历史文件。模型失败时继续正常对话。',
          ),
        ),
        h(
          'details',
          null,
          h('summary', null, '高级：语义向量与遗忘'),
          h(
            'section',
            null,
            field('辅助 provider（留空跟随会话）', 'memory', 'provider'),
            field('Replyer 最大输出 token 数', 'replyer', 'maxTokens', 'number'),
            field('Replyer 等待上限（毫秒）', 'replyer', 'timeoutMs', 'number'),
            field('Replyer 温度', 'replyer', 'temperature', 'number'),
            field('闲聊建议字数', 'replyer', 'chatChars', 'number'),
            field('辅助 model（留空跟随会话）', 'memory', 'model'),
            field('每次最多召回条数', 'memory', 'recallLimit', 'number'),
            field('启用向量服务', 'embedding', 'enabled', 'checkbox'),
            field('嵌入接口完整地址', 'embedding', 'endpoint'),
            field('嵌入模型', 'embedding', 'model'),
            field('凭据环境变量名（不要填密钥值）', 'embedding', 'keyEnv'),
            field('向量维度，0 自动', 'embedding', 'dimensions', 'number'),
            field('记忆半衰期（天）', 'memory', 'halfLifeDays', 'number'),
            field('原始片段保留天数', 'memory', 'sourceDays', 'number'),
            h(
              'small',
              null,
              '向量服务按配置发送查询与记忆文本；不配置时使用稀疏检索和一跳关系扩展。固定 4 个半衰期未访问的未保护记忆会冻结，可手动恢复。',
            ),
          ),
        ),
        h(
          'div',
          null,
          h(
            'button',
            {
              disabled: busy,
              onClick: () =>
                run(async () => {
                  const j = await request('settings', {
                    config: cfg,
                    revision: data?.configRevision,
                  })
                  setCfg(j.config)
                  setData((d) => ({ ...d, config: j.config, configRevision: j.configRevision }))
                  setMessage('已保存，下一轮对话使用新配置')
                }),
            },
            '保存设置',
          ),
          h(
            'button',
            {
              disabled: busy,
              onClick: () => {
                if (!dirty || window.confirm('放弃未保存的修改并重新读取？')) run(load)
              },
            },
            '重新读取',
          ),
        ),
        h(
          'section',
          null,
          h('h3', null, '记忆管理'),
          h(
            'select',
            { value: scope, onChange: (e) => setScope(e.target.value) },
            h('option', { value: '' }, '请选择记忆范围'),
            (data?.scopes ?? []).map((s) =>
              h(
                'option',
                { key: s.namespace, value: s.namespace },
                s.cwd || s.session || s.namespace,
              ),
            ),
          ),
          !items.length ? h('small', null, '还没有记忆。启用后聊几轮，再点击重新读取。') : null,
          items.map((item) =>
            h(
              'article',
              { key: item.id },
              h('strong', null, item.kind + ' · ' + item.status + (item.pinned ? ' · 已保护' : '')),
              h('div', null, item.subject + ' / ' + item.predicate + '：' + item.text),
              h('small', null, '证据：' + JSON.parse(item.evidence).join('；')),
              h(
                'small',
                null,
                '来源：' + item.source + ' · ' + new Date(item.created).toLocaleString(),
              ),
              h(
                'button',
                {
                  disabled: busy,
                  onClick: () => {
                    setEditing(item.id)
                    setCorrection(item.text)
                  },
                },
                '修正',
              ),
              ['approve', 'reject', 'pin', 'forget'].map((action, i) =>
                h(
                  'button',
                  {
                    key: action,
                    disabled: busy,
                    onClick: () =>
                      run(async () => {
                        await request('review', { id: item.id, action })
                        await load(true)
                      }),
                  },
                  ['确认 / 恢复', '拒绝', '切换保护', '删除'][i],
                ),
              ),
            ),
          ),
        ),
        editing
          ? h(
              'section',
              null,
              h('h3', null, '修正记忆'),
              h('textarea', { value: correction, onChange: (e) => setCorrection(e.target.value) }),
              h('small', null, '保存会记录为你手动确认的新事实，原条目标记为已替代。'),
              h(
                'button',
                {
                  disabled: busy,
                  onClick: () =>
                    run(async () => {
                      await request('correct', { id: editing, text: correction })
                      setEditing(null)
                      await load(true)
                    }),
                },
                '确认修正',
              ),
              h('button', { onClick: () => setEditing(null) }, '取消'),
            )
          : null,
        h(
          'section',
          null,
          h('h3', null, '运行状态'),
          h(
            'pre',
            null,
            JSON.stringify(
              { status: data?.status, stats: data?.stats, replyerEvents: data?.replyerEvents },
              null,
              2,
            ),
          ),
          (data?.jobs ?? [])
            .filter((j) => j.state === 'failed')
            .map((j) =>
              h(
                'div',
                { key: j.source },
                '记忆整理失败：' + j.error,
                h(
                  'button',
                  {
                    disabled: busy,
                    onClick: () =>
                      run(async () => {
                        await request('retry', { id: j.source })
                        await load(true)
                      }),
                  },
                  '重新排队',
                ),
              ),
            ),
        ),
        message ? h('p', { role: 'status' }, message) : null,
      )
    }
    const apply = (ctx) =>
      ctx.effect(() =>
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'natural-dialogue', order: 7, label: () => '自然对话' },
            Settings,
          ),
        ),
      )
    return { apply, inject: ['slots'], Settings }
  },
})
