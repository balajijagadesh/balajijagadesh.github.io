const $ = id => document.getElementById(id);
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LANGS = [
  { code: "en", name: "English" },
  { code: "hi", name: "Hindi" },
  { code: "ta", name: "Tamil" },
  { code: "te", name: "Telugu" },
  { code: "kn", name: "Kannada" },
  { code: "ml", name: "Malayalam" },
  { code: "bn", name: "Bengali" },
  { code: "mr", name: "Marathi" },
  { code: "gu", name: "Gujarati" },
  { code: "pa", name: "Punjabi" },
  { code: "or", name: "Odia" },
  { code: "as", name: "Assamese" },
  { code: "ur", name: "Urdu" }
];

function populateLanguageSelects() {
  const source = $("sourceLang");
  const target = $("targetLang");
  LANGS.forEach(lang => {
    const optS = document.createElement("option");
    optS.value = lang.code;
    optS.textContent = lang.name;
    source.appendChild(optS);

    const optT = document.createElement("option");
    optT.value = lang.code;
    optT.textContent = lang.name;
    target.appendChild(optT);
  });

  const savedS = localStorage.getItem("wikitr_source") || "en";
  const savedT = localStorage.getItem("wikitr_target") || "ta";
  source.value = savedS;
  target.value = savedT;
}

function attachLangSaveHandlers() {
  $("sourceLang").addEventListener("change", e => localStorage.setItem("wikitr_source", e.target.value));
  $("targetLang").addEventListener("change", e => localStorage.setItem("wikitr_target", e.target.value));
}

function setProgress(pct, text) {
  $("progressBar").style.width = `${pct}%`;
  $("progressText").textContent = text || "";
}

function stripParentheses(s) { return s.replace(/\s*\([^)]*\)/g,'').trim(); }
function hasParentheses(s) { return /\(.+\)/.test(s); }

async function convertText() {
  const inputText = $("inputBox").value;
  if (!inputText.trim()) { $("outputBox").textContent=""; return; }

  const sourceCode = $("sourceLang").value;
  const targetCode = $("targetLang").value;
  const sourceWiki = `${sourceCode}.wikipedia.org`;
  const targetWikiKey = `${targetCode}wiki`;

  const bracketRegex = /\[\[([\s\S]*?)\]\]/g;
  const matches = [...inputText.matchAll(bracketRegex)];
  if (!matches.length) { $("outputBox").textContent = inputText; return; }

  const mapping = new Map();
  setProgress(10,"Preparing queries...");
  for (const m of matches) {
    let raw = m[1].trim();
    if (raw.includes("|")) raw = raw.split("|")[0].trim();
    if (!mapping.has(raw)) mapping.set(raw,{sourceTitle:raw});
  }

  const keys = Array.from(mapping.keys());
  const total = keys.length; let done=0;
  setProgress(20,`Resolving ${total} item(s)...`);

  for (const key of keys) {
    const entry = mapping.get(key);
    try {
      const pageTitleEnc = encodeURIComponent(entry.sourceTitle);
      const srcResp = await fetch(`https://${sourceWiki}/w/api.php?action=query&format=json&titles=${pageTitleEnc}&prop=pageprops&redirects=1&origin=*`);
      const srcJson = await srcResp.json();
      const pages = srcJson.query && srcJson.query.pages ? srcJson.query.pages : {};
      const pageId = Object.keys(pages)[0]; const page = pages[pageId];
      const wikibaseItem = page?.pageprops?.wikibase_item || null;

      if (!wikibaseItem) {
        mapping.set(key,{...entry,targetTitleRaw:null,bracketReplacement:`[[${entry.sourceTitle}]]`,plainReplacement:entry.sourceTitle});
        done++; continue;
      }

      const wdResp = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&ids=${encodeURIComponent(wikibaseItem)}&props=sitelinks&origin=*`);
      const wdJson = await wdResp.json();
      const ent = wdJson.entities[wikibaseItem];
      const targetTitle = ent?.sitelinks?.[targetWikiKey]?.title || null;

      if (!targetTitle) {
        mapping.set(key,{...entry,targetTitleRaw:null,bracketReplacement:`[[${entry.sourceTitle}]]`,plainReplacement:entry.sourceTitle});
        done++; continue;
      }

      const bracketed = hasParentheses(targetTitle) ? `[[${targetTitle}|]]` : `[[${targetTitle}]]`;
      mapping.set(key,{
        ...entry,
        targetTitleRaw:targetTitle,
        bracketReplacement:bracketed,
        plainReplacement:stripParentheses(targetTitle)
      });

    } catch(e){
      mapping.set(key,{...entry,targetTitleRaw:null,bracketReplacement:`[[${entry.sourceTitle}]]`,plainReplacement:entry.sourceTitle});
      console.error("Error resolving", key, e);
    } finally {
      done++; setProgress(70+Math.round((done/total)*20),`Resolved ${done}/${total}`);
    }
  }

  setProgress(90,"Composing output...");
  let output = inputText.replace(bracketRegex,(full,inner)=>{
    let innerTrim = inner.trim(); if(innerTrim.includes("|")) innerTrim=innerTrim.split("|")[0].trim();
    return mapping.get(innerTrim)?.bracketReplacement || full;
  });

  // 🔧 FIX: Also replace case-insensitive matches and ignore parentheses in plain text
  for(const [src, info] of mapping.entries()){
    if(!info.plainReplacement) continue;

    const esc = escapeRegExp(src);
    const baseWithoutParens = stripParentheses(src);
    const escBase = escapeRegExp(baseWithoutParens);

    try{
      const lookbehindSupported=(()=>{try{new RegExp('(?<!a)b'); return true}catch(e){return false}})();
      if(lookbehindSupported){
        // Match both with and without parentheses, case-insensitive
        const wordRegex = new RegExp(`(?<!\\[\\[)\\b(${esc}|${escBase})\\b(?!\\|)`, 'gi');
        output = output.replace(wordRegex, info.plainReplacement);
      }else{
        const parts=[]; let lastIndex=0; let m;
        const brRe=/\[\[[\s\S]*?\]\]/g;
        while((m=brRe.exec(output))!==null){
          parts.push({text:output.substring(lastIndex,m.index),bracket:false});
          parts.push({text:m[0],bracket:true});
          lastIndex=m.index+m[0].length;
        }
        parts.push({text:output.substring(lastIndex),bracket:false});
        for(let i=0;i<parts.length;i++){
          if(!parts[i].bracket)
            parts[i].text = parts[i].text.replace(new RegExp(`\\b(${esc}|${escBase})\\b`,'gi'),info.plainReplacement);
        }
        output=parts.map(p=>p.text).join('');
      }
    }catch(err){ console.warn("Replace issue",src,err);}
  }

  setProgress(100,"Done");
  setTimeout(()=>setProgress(0,"Idle"),600);
  $("outputBox").textContent = output;
}

function setupUI() {
  populateLanguageSelects();
  attachLangSaveHandlers();

  $("convertBtn").addEventListener("click", async()=>{setProgress(5,"Starting..."); await convertText();});
  $("inputBox").addEventListener("keydown",(e)=>{if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault(); $("convertBtn").click();}});

  $("clearInputBtn").addEventListener("click",()=>{$("inputBox").value=""; $("inputBox").focus();});
  $("clearBtn").addEventListener("click",()=>{$("inputBox").value=""; $("outputBox").textContent="";});

  $("copyBtn").addEventListener("click",async()=>{
    try{
      await navigator.clipboard.writeText($("outputBox").textContent);
      const old=$("copyBtn").textContent;
      $("copyBtn").textContent="Copied!";
      setTimeout(()=>$("copyBtn").textContent=old,1200);
    }catch{alert("Unable to copy. Select and copy manually.");}
  });
}

document.addEventListener("DOMContentLoaded",()=>{
  setupUI();
  $("inputBox").value=`[[India]] is a big country. I like India.
[[Bala (actor)|Bala]] did many films.
Also test: [[India|Indian subcontinent]]`;
});
