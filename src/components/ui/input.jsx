import React from 'react'

export function Input({ className = '', ...props }){
  return <input className={`w-full h-9 px-3 border rounded-md outline-none focus:ring ring-gray-200 ${className}`} {...props} />
}
