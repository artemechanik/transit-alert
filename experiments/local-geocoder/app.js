const input = document.querySelector('#query'), list = document.querySelector('#results');
const status = document.querySelector('#status');
let timer, controller, generation = 0, items = [], active = -1;
function close() {
  items = []; active = -1; list.replaceChildren();
  input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
}
function choose(i) {
  const r = items[i]; if (!r) return;
  clearTimeout(timer); controller?.abort(); generation++;
  document.querySelector('#selection').hidden = false;
  document.querySelector('#selected-name').textContent = r.display_name;
  document.querySelector('#details').textContent =
    'Тип: ' + (r.type === 'street' ? 'вулиця (репрезентативна точка)' : 'адреса будинку') + '\n' +
    'Широта: ' + r.lat + '\nДовгота: ' + r.lon + '\nSIMC: ' + r.simc +
    '\nULIC: ' + (r.ulic || '—') + '\nTERC: ' + r.terc + '\nСтабільний ID: ' + r.id + '\nPRG ID (версія): ' + r.source_id;
  input.value = r.type === 'street' ? r.street + ' ' : r.display_name;
  close();
  status.textContent = r.type === 'street'
    ? 'Вулицю обрано. Можна дописати номер будинку. Координати позначають точку вулиці.'
    : 'Адресу обрано.';
}
function activate(i) {
  active = i;
  [...list.children].forEach((el,j) => el.setAttribute('aria-selected', String(j===i)));
  if (i>=0) { input.setAttribute('aria-activedescendant','option-'+i); list.children[i]?.scrollIntoView({block:'nearest'}); }
}
input.addEventListener('input', () => {
  clearTimeout(timer); controller?.abort(); const version = ++generation;
  close(); document.querySelector('#selection').hidden = true;
  const q = input.value.trim();
  if (!q) { status.textContent = 'Введіть адресу.'; return; }
  status.textContent = 'Пошук…';
  timer = setTimeout(async () => {
    controller = new AbortController();
    try {
      const response = await fetch('/search?' + new URLSearchParams({q,limit:'10'}),{signal:controller.signal});
      const data = await response.json(); if (version!==generation) return;
      if (!response.ok) throw Error(data.error);
      items = data.results;
      status.textContent = (items.length ? items.length+' підказок · '+data.elapsed_ms.toFixed(1)+' мс' :
        'У локальному наборі збігів немає. Це не доводить, що адреса не існує.') +
        (data.warning ? ' '+data.warning : '');
      items.forEach((r,i) => {
        const li = document.createElement('li'); li.id='option-'+i;
        li.role='option'; li.setAttribute('aria-selected','false');
        li.textContent=r.display_name;
        const small=document.createElement('small');
        small.textContent=(r.type === 'street' ? 'Вулиця' : 'Адреса')+' · SIMC '+r.simc+' · TERC '+r.terc +
          (r.origin === 'PRG_address_group' ? ' · група адресних точок' : '');
        li.append(small); li.addEventListener('click',()=>choose(i)); list.append(li);
      });
      input.setAttribute('aria-expanded',String(items.length>0));
    } catch(e) { if(e.name!=='AbortError' && version===generation) status.textContent=e.message; }
  },220);
});
input.addEventListener('keydown', e => {
  if(e.key==='Escape') { clearTimeout(timer); controller?.abort(); generation++; close(); status.textContent='Підказки закрито.'; }
  if(e.key==='ArrowDown' && items.length) { e.preventDefault(); activate((active+1)%items.length); }
  if(e.key==='ArrowUp' && items.length) { e.preventDefault(); activate((active-1+items.length)%items.length); }
  if(e.key==='Enter' && items.length) { e.preventDefault(); choose(active<0?0:active); }
});
fetch('/stats').then(r=>r.json()).then(s=>{
  document.querySelector('#stats').textContent=s.addresses.toLocaleString('uk')+' адрес · '+s.unique_simc+
    ' SIMC · '+s.streets+' вулиць · '+s.packages+' гмін · без зовнішніх запитів';
}).catch(()=>{});
