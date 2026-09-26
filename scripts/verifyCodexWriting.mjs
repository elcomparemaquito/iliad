import {_electron as electron} from 'playwright';
import {mkdir,copyFile,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
// Opt-in live test: uses an explicitly supplied Iliad profile and consumes its Codex quota.
// Run only on Windows, with synthetic documents. Never include the artifacts in Git.
const sourceProfile=process.argv[2];
const executable=process.argv[3];
if(process.platform!=='win32'||!sourceProfile||!executable)throw new Error('Usage: node scripts/verifyCodexWriting.mjs <authenticated-Iliad-profile> <installed-exe> [en|es]');
const spanish=process.argv[4]==='es';
const root=path.resolve('test-artifacts',`codex-live-${Date.now()}`);const profile=path.join(root,'profile');const docs=path.join(root,'documents');await mkdir(path.join(profile,'codex-writing'),{recursive:true});await mkdir(path.join(profile,'assistant'),{recursive:true});await mkdir(docs,{recursive:true});
await copyFile(path.join(sourceProfile,'codex-writing/auth.json'),path.join(profile,'codex-writing/auth.json'));await copyFile(path.join(sourceProfile,'assistant/settings.json'),path.join(profile,'assistant/settings.json'));
const prose=spanish?'La ciudad estaba muy silenciosa y Ana caminaba lentamente hacia la estación con una carta que todavía no había leído.':'The city was very quiet and Ana walked slowly toward the station carrying a letter she had not yet read.';
const initial=`# Prueba\n\n${prose}\n`;const doc=path.join(docs,'Prueba.md');await writeFile(doc,initial);
const env={...process.env,ILIAD_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
let app,page;const results=[];const pass=x=>{results.push(x);console.log('PASS '+x);};
async function waitDisk(expected, equal=true){const until=Date.now()+15000;while(Date.now()<until){if(((await readFile(doc,'utf8'))===expected)===equal)return;await page.waitForTimeout(150);}assert.fail('File did not reach expected saved state');}
async function launch(){app=await electron.launch({executablePath:path.resolve(executable),args:[docs],env});page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('dialog',d=>{if(d.type()!=='beforeunload')void d.dismiss();});await page.getByRole('button',{name:'Prueba Prueba.md',exact:true}).click();await page.locator('.cm-content').waitFor();}
try{
 await launch();const status=await page.evaluate(()=>window.iliad.getWritingAssistStatus());assert.equal(status.codex.model,'gpt-6-luna');assert.equal(status.codex.state,'connected');pass('Installed runtime and model connected');
 const editor=page.locator('.cm-content');await editor.click();await editor.press('Control+End');await editor.press('Control+Shift+Home');await editor.press('Control+Enter');
 await page.waitForTimeout(400);
 await page.getByRole('option',{name:/Acortar|Shorten/,exact:true}).click();await page.locator('[data-review-action="reject"]').first().waitFor({timeout:90000});assert.equal(await readFile(doc,'utf8'),initial);await page.locator('[data-review-action="reject"]').first().click();await page.waitForTimeout(800);assert.equal(await readFile(doc,'utf8'),initial);pass('Reject preserves exact file');
 async function selectAll(){await editor.click();await editor.press('Control+Home');await editor.press('Control+Shift+End');await editor.press('Control+Enter');}
 for(const preset of [/^Reescribir|^Rewrite/,/^Ampliar|^Expand/,/^Acortar|^Shorten/,/^Resumir|^Summarize/,/^Convertir en lista|^Turn into/]){
   await selectAll();await page.getByRole('option',{name:preset}).click();await page.locator('[data-review-action="accept"]').first().waitFor({timeout:90000});assert.equal(await readFile(doc,'utf8'),initial);
   await page.locator('[data-review-action="accept"]').first().click();await waitDisk(initial,false);
   await editor.press('Control+z');await waitDisk(initial);pass('Accept, autosave and exact undo '+preset);
 }
 await selectAll();const input=page.locator('.editor-ai-menu textarea');await input.fill(spanish?'Reescribe este pasaje en presente. Mantén el español.':'Rewrite this passage in the present tense. Keep it in English.');await input.press('Enter');await page.locator('[data-review-action="accept"]').first().waitFor({timeout:90000});assert.equal(await readFile(doc,'utf8'),initial);await page.locator('[data-review-action="accept"]').first().click();await waitDisk(initial,false);await editor.press('Control+z');await waitDisk(initial);pass('Custom instruction accept and exact undo');
 await page.getByRole('button',{name:/Ayudas de escritura|Writing assists/,exact:true}).click();const toggle=page.getByRole('switch',{name:/^Autocompletar|^Autocomplete/});if(await toggle.getAttribute('aria-checked')!=='true')await toggle.click();await page.getByRole('button',{name:/Ayudas de escritura|Writing assists/,exact:true}).click();
 for(const key of ['Control+,','Control+.','Control+/']){
   await editor.click();await editor.press('Control+End');await editor.press(key);await page.getByRole('button',{name:/Aceptar Tab|Accept Tab/}).waitFor({timeout:90000});assert.equal(await readFile(doc,'utf8'),initial);
   await page.getByRole('button',{name:/Aceptar Tab|Accept Tab/}).click();await waitDisk(initial,false);await editor.press('Control+z');await waitDisk(initial);pass('Continuation accept and exact undo '+key);
 }
 await editor.press('Control+End');await editor.press('Control+,');await editor.press('Escape');await page.waitForTimeout(2500);assert.equal(await readFile(doc,'utf8'),initial);assert.equal(await page.getByRole('button',{name:/Aceptar Tab|Accept Tab/}).count(),0);pass('Cancel leaves no proposal or file change');
 await editor.press('Control+End');await editor.press('Control+,');await editor.type(' Cambio durante la respuesta.');await page.waitForTimeout(3000);assert.equal(await page.getByRole('button',{name:/Aceptar Tab|Accept Tab/}).count(),0);pass('Editing cancels pending suggestion');
 const saved=await readFile(doc,'utf8');await app.close();await launch();assert.equal(await readFile(doc,'utf8'),saved);const restarted=await page.evaluate(()=>window.iliad.getWritingAssistStatus());assert.equal(restarted.codex.model,'gpt-6-luna');assert.equal(restarted.codex.state,'connected');pass('Restart preserves content, session and model');
}catch(e){console.log('FAILED',e.message);console.log('UI',await page.locator('body').innerText());await page.screenshot({path:path.join(root,'failure.png'),timeout:2000}).catch(()=>{});process.exitCode=1;}finally{await app?.close();await writeFile(path.join(root,'results.json'),JSON.stringify(results,null,2));}
