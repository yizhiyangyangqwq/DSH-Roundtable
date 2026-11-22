/**
 * Enable or disable the roundtable plugin in the desktop profile.
 *
 *   node toggle.mjs off     # remove it from the bundle list (DSH starts clean)
 *   node toggle.mjs on      # put it back
 *   node toggle.mjs status  # show the current state
 *
 * Rewriting the profile package.json is safer than telling the user to hand-edit
 * it, because a malformed file stops DSH from booting at all.
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROFILE = join(homedir(), '.dsh', 'profiles', 'desktop', 'package.json')
const DEP = '@local/roundtable'
const DEP_VALUE = 'link:H:/DeepSeekHarness插件工作区/roundtable-plugin'

const action = (process.argv[2] ?? 'status').toLowerCase()

const raw = readFileSync(PROFILE, 'utf8')
const pkg = JSON.parse(raw)

const bundles = pkg.dsh?.profile?.bundles ?? []
const inBundles = bundles.includes(DEP)
const inDeps = pkg.dependencies?.[DEP] !== undefined

if (action === 'status') {
  console.log('profile:  ' + PROFILE)
  console.log('依赖已声明: ' + (inDeps ? '是' : '否'))
  console.log('bundle 已启用: ' + (inBundles ? '是' : '否'))
  console.log('')
  console.log(inBundles ? '插件当前是启用的。' : '插件当前是停用的。')
  process.exit(0)
}

if (action !== 'on' && action !== 'off') {
  console.error('用法: node toggle.mjs on|off|status')
  process.exit(2)
}

// Keep one rolling backup so a bad edit is always recoverable by hand.
copyFileSync(PROFILE, PROFILE + '.roundtable-backup')

if (action === 'off') {
  pkg.dsh.profile.bundles = bundles.filter((b) => b !== DEP)
  writeFileSync(PROFILE, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  console.log('已停用：从 bundle 列表中移除 ' + DEP)
  console.log('（依赖声明保留，重启用只需再跑 on）')
} else {
  if (!pkg.dependencies) pkg.dependencies = {}
  pkg.dependencies[DEP] = DEP_VALUE
  if (!bundles.includes(DEP)) pkg.dsh.profile.bundles = [...bundles, DEP]
  writeFileSync(PROFILE, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  console.log('已启用：' + DEP)
}

console.log('重启 DSH 后生效。')
