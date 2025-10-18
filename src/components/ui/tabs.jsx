import React, { createContext, useContext } from 'react'

const TabsCtx = createContext(null)

export function Tabs({ value, onValueChange, children }){
  return <TabsCtx.Provider value={{ value, onValueChange }}>{children}</TabsCtx.Provider>
}

export function TabsList({ children, className = '' }){
  return <div className={`inline-flex gap-1 border rounded-md p-1 ${className}`}>{children}</div>
}

export function TabsTrigger({ value, children }){
  const ctx = useContext(TabsCtx)
  const active = ctx?.value === value
  return (
    <button
      onClick={()=> ctx?.onValueChange?.(value)}
      className={`px-3 py-1 rounded-md text-sm ${active ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 hover:bg-gray-50 border'}`}
      aria-selected={active}
      role="tab"
    >
      {children}
    </button>
  )
}

export function TabsContent({ value, children, className = '' }){
  const ctx = useContext(TabsCtx)
  if (ctx?.value !== value) return null
  return <div className={className}>{children}</div>
}
