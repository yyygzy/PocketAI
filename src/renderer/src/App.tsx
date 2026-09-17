import React, { useState } from 'react'
import { Sidebar, type ModuleId } from './components/Sidebar'
import { TabBar, type Tab } from './components/TabBar'
import { Workspace } from './components/Workspace'
import { useI18n } from './i18n'

let tabCounter = 0
const newTabId = () => `tab-${Date.now()}-${++tabCounter}`

export default function App() {
  const { t } = useI18n()
  const [activeModule, setActiveModule] = useState<ModuleId>('chat')
  const [collapsed, setCollapsed] = useState(false)
  const [tabs, setTabs] = useState<Tab[]>(() => [
    { id: newTabId(), title: t('tab.newChat'), moduleId: 'chat' }
  ])
  const [activeTabId, setActiveTabId] = useState<string>(tabs[0].id)

  const activeTab = tabs.find((tb) => tb.id === activeTabId)

  const moduleTitle = (id: ModuleId): string => {
    const map: Record<ModuleId, string> = {
      chat: t('tab.newChat'),
      agent: t('tab.newAgent'),
      skills: t('tab.skills'),
      knowledge: t('tab.knowledge'),
      files: t('tab.files'),
      steward: t('tab.steward'),
      settings: t('tab.settings')
    }
    return map[id]
  }

  const handleModuleChange = (id: ModuleId) => {
    setActiveModule(id)
    // 切换模块时，若已有该模块标签则激活，否则新建
    const existing = tabs.find((tb) => tb.moduleId === id)
    if (existing) {
      setActiveTabId(existing.id)
    } else {
      const tab: Tab = {
        id: newTabId(),
        title: moduleTitle(id),
        moduleId: id
      }
      setTabs((prev) => [...prev, tab])
      setActiveTabId(tab.id)
    }
  }

  const handleNewTab = () => {
    const tab: Tab = {
      id: newTabId(),
      title: moduleTitle(activeModule),
      moduleId: activeModule
    }
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
  }

  const handleCloseTab = (id: string) => {
    setTabs((prev) => {
      const next = prev.filter((tb) => tb.id !== id)
      if (id === activeTabId && next.length > 0) {
        setActiveTabId(next[next.length - 1].id)
      }
      if (next.length === 0) {
        const tb: Tab = { id: newTabId(), title: t('tab.newChat'), moduleId: 'chat' }
        setActiveTabId(tb.id)
        return [tb]
      }
      return next
    })
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar
        active={activeModule}
        onChange={handleModuleChange}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
      />
      <div className="flex flex-col flex-1 min-w-0">
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={setActiveTabId}
          onClose={handleCloseTab}
          onNew={handleNewTab}
        />
        <Workspace moduleId={(activeTab?.moduleId as ModuleId) || 'chat'} />
      </div>
    </div>
  )
}
