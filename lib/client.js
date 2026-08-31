/**
 * dupguard 浏览器端 bundle（单文件，经 window.__ModuleLoader__ 加载）。
 *
 * 在 DSH 设置面板注册一个与「通用设置 / 模型 / 插件 / Agent 预设」并列的
 * 分节「重复守卫」：白名单（检测时忽略的字符）的可视化编辑界面。
 * 数据经 settingsScope 绑定宿主 settings 服务的 "dsh-dupguard" 命名空间，
 * 修改即时生效并持久化（settings.yaml）。
 *
 * 样式全部使用 --dsw-* 主题变量，跟随全局亮/暗主题，与原有设置页风格一致。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dupguard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const NS = 'dsh-dupguard'
    const SETTINGS_NS = 'dsh-dupguard'

    const zh = {
      nav: '重复守卫',
      title: '重复输出守卫',
      intro: '模型输出中同一字符串连续重复 10 次以上时会自动截停。此处配置检测时忽略的字符（白名单）：这些字符不参与重复统计，例如 Markdown 表格分隔行会大量使用连字符与竖线。',
      list: '当前白名单',
      empty: '白名单为空：所有字符都参与重复统计。',
      addPlaceholder: '输入要忽略的字符',
      add: '添加',
      reset: '恢复默认',
      loading: '加载中…',
      note: '修改即时生效；「恢复默认」回到连字符与竖线。',
    }
    const en = {
      nav: 'Dupguard',
      title: 'Repetition Guard',
      intro: 'Generation stops when the same string repeats 10 or more times in a row. Configure the whitelisted characters that are ignored during detection, e.g. Markdown table separators use many hyphens and pipes.',
      list: 'Whitelist',
      empty: 'Whitelist is empty: every character counts.',
      addPlaceholder: 'Character to ignore',
      add: 'Add',
      reset: 'Reset to defaults',
      loading: 'Loading…',
      note: 'Changes take effect immediately; "Reset to defaults" restores hyphen and pipe.',
    }

    const css = [
      '.dg-section{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dg-title{font-size:15px;font-weight:600;line-height:24px;margin:0}',
      '.dg-intro{color:var(--dsw-alias-label-secondary);margin:0}',
      '.dg-chips{display:flex;flex-wrap:wrap;gap:8px}',
      '.dg-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 6px 0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.dg-chip-remove{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border:none;border-radius:5px;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:13px;line-height:1;padding:0}',
      '.dg-chip-remove:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dg-add{display:flex;gap:8px}',
      '.dg-input{flex:1;max-width:240px;height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none;font-family:inherit}',
      '.dg-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dg-btn{height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;font-family:inherit}',
      '.dg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dg-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-on-primary,#fff)}',
      '.dg-btn-primary:hover{background:var(--dsw-alias-brand-primary)}',
      '.dg-note{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}',
      '.dg-empty{color:var(--dsw-alias-label-tertiary);margin:0}',
    ].join('\n')

    if (typeof document !== 'undefined') {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-dupguard'
      tag.dataset.pluginCss = 'dsh-dupguard/client.css'
      tag.textContent = css
      document.head.appendChild(tag)
    }

    const inject = ['slots', 'locale', 'connection', 'settingsScope']

    function DupguardSection(props) {
      const controller = props.controller
      const t = props.t
      const snap = React.useSyncExternalStore(
        (cb) => controller.subscribe(cb),
        () => controller.getSnapshot(),
      )
      const [draft, setDraft] = React.useState('')

      if (snap.status !== 'ready') {
        return React.createElement('div', { className: 'dg-section' },
          React.createElement('p', { className: 'dg-empty' }, t('loading')))
      }
      const list = Array.isArray(snap.value && snap.value.ignoredChars) ? snap.value.ignoredChars : []

      const remove = (ch) => {
        controller.set('ignoredChars', list.filter((item) => item !== ch))
      }
      const add = () => {
        const ch = draft.trim()
        if (ch.length === 0) return
        if (list.indexOf(ch) !== -1) {
          setDraft('')
          return
        }
        controller.set('ignoredChars', [...list, ch])
        setDraft('')
      }
      const reset = () => {
        controller.unset('ignoredChars')
      }
      const onKey = (e) => {
        if (e.key === 'Enter') add()
      }

      return React.createElement('div', { className: 'dg-section' },
        React.createElement('h2', { className: 'dg-title' }, t('title')),
        React.createElement('p', { className: 'dg-intro' }, t('intro')),
        React.createElement('p', { className: 'dg-note' }, t('list')),
        list.length === 0
          ? React.createElement('p', { className: 'dg-empty' }, t('empty'))
          : React.createElement('div', { className: 'dg-chips' },
            list.map((ch) => React.createElement('span', { className: 'dg-chip', key: ch },
              ch,
              React.createElement('button', {
                className: 'dg-chip-remove',
                onClick: () => remove(ch),
                'aria-label': 'remove',
              }, '\u00d7')))),
        React.createElement('div', { className: 'dg-add' },
          React.createElement('input', {
            className: 'dg-input',
            placeholder: t('addPlaceholder'),
            value: draft,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: onKey,
          }),
          React.createElement('button', { className: 'dg-btn dg-btn-primary', onClick: add }, t('add')),
          React.createElement('button', { className: 'dg-btn', onClick: reset }, t('reset')),
        ),
        React.createElement('p', { className: 'dg-note' }, t('note')),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dupguard: dictionaries')
      const t = ctx.locale.bind(NS)
      const controller = ctx.settingsScope.bind({ namespace: SETTINGS_NS })
      ctx.effect(() => () => {
        controller.dispose()
      }, 'dupguard: settings scope')
      const injected = () => ({ controller, t })
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dupguard',
        order: 25,
        label: () => t('nav'),
        inject: injected,
      }, DupguardSection))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
