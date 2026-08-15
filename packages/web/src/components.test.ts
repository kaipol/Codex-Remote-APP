// @vitest-environment jsdom
import{describe,expect,it,vi}from'vitest';import{mount}from'@vue/test-utils';import ApprovalSheet from'./components/ApprovalSheet.vue';
import ComposerBox from'./components/ComposerBox.vue';
import AppShell from'./components/AppShell.vue';
import SessionSidebar from'./components/SessionSidebar.vue';
import MessageBubble from'./components/MessageBubble.vue';
import ConversationTimeline from'./components/ConversationTimeline.vue';
import PairingSurface from'./components/PairingSurface.vue';
const approval={request_id:'1:1',session_id:'s',kind:'item/commandExecution/requestApproval',payload:{command:'test'},status:'pending' as const,created_at:'x',updated_at:'x'};
describe('pairing endpoint',()=>{
 it('emits the normalized input pair with its server address',async()=>{const wrapper=mount(PairingSurface,{props:{busy:false,error:'',initialServer:'http://192.168.1.2:8787'}});await wrapper.findAll('input')[1].setValue('123456');await wrapper.get('button.primary').trigger('click');expect(wrapper.emitted('pair')?.[0]).toEqual(['123456','http://192.168.1.2:8787'])});
});
describe('approval decisions',()=>{
 it('emits an accept decision',async()=>{const wrapper=mount(ApprovalSheet,{props:{open:true,approvals:[approval]}});expect(wrapper.text()).toContain('Codex 请求确认');await wrapper.find('button.primary').trigger('click');expect(wrapper.emitted('decide')?.[0]).toEqual([approval,'accept'])});
 it('does not allow remote permission grants',()=>{const wrapper=mount(ApprovalSheet,{props:{open:true,approvals:[{...approval,kind:'item/permissions/requestApproval'}]}});expect(wrapper.text()).toContain('只能拒绝');expect(wrapper.find('button.primary').attributes('disabled')).toBeDefined()});
});

const composerProps={disabled:false,activeTurn:false,online:true,queued:0,sending:false,models:[],skills:[],apps:[],defaults:{},capabilitiesLoading:false,cwd:''};
describe('composer settings panels',()=>{
 it('keeps access approval separate from model settings',async()=>{
  const wrapper=mount(ComposerBox,{props:composerProps});
  await wrapper.get('button.combined-access').trigger('click');
  expect(wrapper.find('.access-popover').exists()).toBe(true);
  expect(wrapper.find('.model-settings-popover').exists()).toBe(false);
  expect(wrapper.get('.access-popover').text()).toContain('请求批准');
  expect(wrapper.get('.access-popover').text()).not.toContain('推理强度');
  await wrapper.get('button.runtime-pill').trigger('click');
  expect(wrapper.find('.access-popover').exists()).toBe(false);
  expect(wrapper.find('.model-settings-popover').exists()).toBe(true);
  expect(wrapper.get('.model-settings-popover').text()).toContain('推理强度');
  expect(wrapper.get('.model-settings-popover').text()).not.toContain('请求批准');
 });
 it('opens reasoning choices as a model subpanel',async()=>{
  const wrapper=mount(ComposerBox,{props:composerProps});
  await wrapper.get('button.runtime-pill').trigger('click');
  await wrapper.findAll('.model-settings-root button')[1].trigger('click');
  expect(wrapper.find('.effort-choice-panel').exists()).toBe(true);
  expect(wrapper.find('.model-settings-root').exists()).toBe(false);
 });
 it('anchors panels to their buttons and closes them outside',async()=>{
  const wrapper=mount(ComposerBox,{props:composerProps,attachTo:document.body});
  await wrapper.get('button.combined-access').trigger('click');
  expect(wrapper.find('.composer-access-anchor .access-popover').exists()).toBe(true);
  document.body.dispatchEvent(new Event('pointerdown',{bubbles:true}));
  await wrapper.vm.$nextTick();
  expect(wrapper.find('.access-popover').exists()).toBe(false);
  wrapper.unmount();
 });
});

describe('application sidebar toggle',()=>{
 it('stays at the app shell and emits the toggle action',async()=>{
  const wrapper=mount(AppShell,{props:{drawerOpen:false,sidebarHidden:false}});
  const button=wrapper.get('button.app-sidebar-toggle');
  expect(button.attributes('aria-label')).toBe('隐藏侧边栏');
  await button.trigger('click');
  expect(wrapper.emitted('toggleSidebar')).toHaveLength(1);
  await wrapper.setProps({sidebarHidden:true});
  expect(button.attributes('aria-label')).toBe('显示侧边栏');
 });
});

describe('new conversation flow',()=>{
 it('emits create from the sidebar button',async()=>{
  const wrapper=mount(SessionSidebar,{props:{sessions:[],loading:false,error:'',busy:false,projects:[],sidebarOrder:{},projectOrder:[]}});
  await wrapper.get('button.new-thread').trigger('click');
  expect(wrapper.emitted('create')).toHaveLength(1);
 });
 it('emits createInCwd from a project group hover button',async()=>{
  const wrapper=mount(SessionSidebar,{props:{sessions:[{session_id:'s1',title:'test',status:'active',pinned:false,cwd:'E:\proj',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'}],activeId:'s1',loading:false,error:'',busy:false,projects:[],sidebarOrder:{},projectOrder:[]}});
  await wrapper.get('.project-new-thread').trigger('click');
  expect(wrapper.emitted('createInCwd')?.[0]).toEqual(['E:\proj']);
 });
});

describe('message rendering controls',()=>{
 it('renders markdown math and message copy controls',async()=>{
  const wrapper=mount(MessageBubble,{props:{message:{msg_id:'m1',session_id:'s',role:'assistant',content:'**结果** $x^2$',timestamp:'2026-01-01T00:00:00Z',seq:1}}});
  await vi.waitFor(()=>expect(wrapper.find('.katex').exists()).toBe(true),{timeout:2000,interval:20});
  expect(wrapper.find('button.assistant-copy').exists()).toBe(true);
 });
 it('hides an explicitly interrupted turn',()=>{
  const wrapper=mount(ConversationTimeline,{props:{messages:[{msg_id:'u1',turn_id:'t1',session_id:'s',role:'user',content:'cancelled prompt',timestamp:'2026-01-01T00:00:00Z',seq:1},{msg_id:'u2',turn_id:'t2',session_id:'s',role:'user',content:'kept prompt',timestamp:'2026-01-01T00:00:02Z',seq:3}],events:[{id:'e1',type:'turn_completed',session:'s',timestamp:'2026-01-01T00:00:01Z',seq:2,metadata:{turn_id:'t1',status:'interrupted'}}],loading:false,pendingStates:{},activeTurn:false}});
  expect(wrapper.text()).not.toContain('cancelled prompt');
  expect(wrapper.text()).toContain('kept prompt');
 });
});
