import React from 'react'

export function Label({ className = '', children, ...props }){
  return <label className={`block text-sm mb-1 ${className}`} {...props}>{children}</label>
}
