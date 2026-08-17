// @vitest-environment jsdom
import{describe,expect,it,vi}from'vitest';import{mount}from'@vue/test-utils';import type { ModelOption } from '@remote/shared';import ApprovalSheet from'./components/ApprovalSheet.vue';
import ComposerBox from'./components/ComposerBox.vue';
import AppShell from'./components/AppShell.vue';
import SessionSidebar from'./components/SessionSidebar.vue';
import SessionItem from'./components/SessionItem.vue';
import MessageBubble from'./components/MessageBubble.vue';
import ConversationTimeline from'./components/ConversationTimeline.vue';
import ReasoningPanel from'./components/ReasoningPanel.vue';
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
 it('preserves a manually selected model across capability refreshes',async()=>{
  const models: ModelOption[]=[
   {id:'m1',model:'model-one',displayName:'模型一',isDefault:true,supportedReasoningEfforts:['medium'],inputModalities:['text']},
   {id:'m2',model:'model-two',displayName:'模型二',supportedReasoningEfforts:['medium'],inputModalities:['text']},
  ];
  const wrapper=mount(ComposerBox,{props:{...composerProps,models,defaults:{model:'model-one',effort:'medium'}}});
  await wrapper.get('button.runtime-pill').trigger('click');
  await wrapper.get('.model-settings-root > button').trigger('click');
  await wrapper.findAll('.model-choice-panel > button').at(1)!.trigger('click');
  expect(wrapper.get('button.runtime-pill').text()).toContain('模型二');
  await wrapper.setProps({models:[...models],defaults:{model:'model-one',effort:'medium'}});
  expect(wrapper.get('button.runtime-pill').text()).toContain('模型二');
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
  expect(wrapper.find('.project-count').text()).toBe('1');
  await wrapper.get('.project-new-thread').trigger('click');
  expect(wrapper.emitted('createInCwd')?.[0]).toEqual(['E:\proj']);
 });
});

describe('session item presentation',()=>{
  it('keeps the sidebar row to the session title and actions',()=>{
    const wrapper=mount(SessionItem,{props:{session:{session_id:'s1',title:'test',status:'active',pinned:false,cwd:'E:\\proj',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',user_message_count:4},selected:false}});
    expect(wrapper.text()).toContain('test');
    expect(wrapper.text()).not.toContain('4');
    expect(wrapper.find('button.session-expand').exists()).toBe(false);
    expect(wrapper.get('button.session-item').attributes('title')).toBe('test');
  });
});

describe('project session limits',()=>{
  it('shows five sessions initially and reveals five more per click',async()=>{
    const sessions=Array.from({length:12},(_,index)=>({
      session_id:`s${index + 1}`,
      title:`session ${index + 1}`,
      status:'active' as const,
      pinned:false,
      cwd:'E:\\\\proj',
      created_at:`2026-01-${String(index + 1).padStart(2,'0')}T00:00:00Z`,
      updated_at:`2026-01-${String(index + 1).padStart(2,'0')}T00:00:00Z`,
    }));
    const wrapper=mount(SessionSidebar,{props:{sessions,loading:false,error:'',busy:false,projects:[],sidebarOrder:{},projectOrder:[]}});

    expect(wrapper.findAll('.session-item-wrap')).toHaveLength(5);
    expect(wrapper.find('button.session-show-more').exists()).toBe(true);

    await wrapper.get('button.session-show-more').trigger('click');
    expect(wrapper.findAll('.session-item-wrap')).toHaveLength(10);

    await wrapper.get('button.session-show-more').trigger('click');
    expect(wrapper.findAll('.session-item-wrap')).toHaveLength(12);
    expect(wrapper.find('button.session-show-more').exists()).toBe(false);
  });
  it('shows a newly discovered session before the persisted sidebar order',()=>{
    const sessions=[
      {session_id:'new',title:'new remote session',status:'active' as const,pinned:false,cwd:'E:\\\\proj',project_id:'p1',project_name:'Project',created_at:'2026-08-16T00:00:00Z',updated_at:'2026-08-16T00:00:00Z'},
      ...Array.from({length:5},(_,index)=>({session_id:`old-${index}`,title:`old ${index}`,status:'active' as const,pinned:false,cwd:'E:\\\\proj',project_id:'p1',project_name:'Project',created_at:'2026-08-15T00:00:00Z',updated_at:`2026-08-15T00:00:0${index}Z`})),
    ];
    const wrapper=mount(SessionSidebar,{props:{sessions,loading:false,error:'',busy:false,projects:[{id:'p1',name:'Project',rootPaths:['E:\\\\proj']}],sidebarOrder:{p1:sessions.slice(1).map(session=>session.session_id)},projectOrder:['p1']}});
    expect(wrapper.findAll('button.session-item')[0].attributes('title')).toBe('new remote session');
  });
});

describe('message rendering controls',()=>{
	it('renders markdown math and message copy controls',async()=>{
	  const wrapper=mount(MessageBubble,{props:{message:{msg_id:'m1',session_id:'s',role:'assistant',content:'**结果** \\(x^2\\)',timestamp:'2026-01-01T00:00:00Z',seq:1}}});
	  await vi.waitFor(()=>expect(wrapper.find('.katex').exists()).toBe(true),{timeout:2000,interval:20});
	  expect(wrapper.find('button.assistant-copy').exists()).toBe(true);
	});
		it('renders an assistant turn that has only tool segments without crashing',async()=>{
		  const wrapper=mount(MessageBubble,{props:{messages:[],segments:[{kind:'tools',group:[{id:'e1',type:'tool_call',session:'s',timestamp:'2026-01-01T00:00:00Z',seq:1,metadata:{tool:'shell',arguments:{}}}]}]}});
		  expect(wrapper.find('.assistant-turn-content').exists()).toBe(true);
		  expect(wrapper.find('.user-footer').exists()).toBe(false);
		  expect(wrapper.find('.assistant-copy').exists()).toBe(false);
		});
		it('renders skill references as icon labels',()=>{
		  const wrapper=mount(MessageBubble,{props:{message:{msg_id:'u1',session_id:'s',role:'user',content:'请使用这个技能',references:[{type:'skill',label:'Ai Slop Cleaner',path:'C:\\skills\\ai-slop-cleaner\\SKILL.md'}],timestamp:'2026-01-01T00:00:00Z',seq:1}}});
		  expect(wrapper.find('.reference-chip.skill').exists()).toBe(true);
		  expect(wrapper.find('.reference-chip.skill svg').exists()).toBe(true);
		  expect(wrapper.get('.reference-chip.skill').text()).toContain('Ai Slop Cleaner');
		});
			it('hides an explicitly interrupted turn',async()=>{
		  const wrapper=mount(ConversationTimeline,{props:{messages:[{msg_id:'u1',turn_id:'t1',session_id:'s',role:'user',content:'cancelled prompt',timestamp:'2026-01-01T00:00:00Z',seq:1},{msg_id:'u2',turn_id:'t2',session_id:'s',role:'user',content:'kept prompt',timestamp:'2026-01-01T00:00:02Z',seq:3}],events:[{id:'e1',type:'turn_completed',session:'s',timestamp:'2026-01-01T00:00:01Z',seq:2,metadata:{turn_id:'t1',status:'interrupted'}}],loading:false,pendingStates:{},activeTurn:false}});
		  await wrapper.vm.$nextTick();
		  expect(wrapper.text()).not.toContain('cancelled prompt');
	  expect(wrapper.text()).toContain('kept prompt');
	 });
		it('keeps an edit affordance on the latest sent user message',()=>{
		  const wrapper=mount(ConversationTimeline,{props:{messages:[{msg_id:'u1',session_id:'s',role:'user',content:'latest prompt',timestamp:'2026-01-01T00:00:00Z',seq:1}],events:[],loading:false,pendingStates:{},activeTurn:false}});
		  expect(wrapper.find('button.message-edit').exists()).toBe(true);
		});
			it('keeps the user-input navigator compact and opt-in',async()=>{
		  const wrapper=mount(ConversationTimeline,{props:{messages:[{msg_id:'u1',session_id:'s',role:'user',content:'first prompt',timestamp:'2026-01-01T00:00:00Z',seq:1},{msg_id:'a1',session_id:'s',role:'assistant',content:'reply',timestamp:'2026-01-01T00:00:01Z',seq:2},{msg_id:'u2',session_id:'s',role:'user',content:'second prompt',timestamp:'2026-01-01T00:00:02Z',seq:3}],events:[],loading:false,pendingStates:{},activeTurn:false}});
		  expect(wrapper.find('.user-jump-rail').exists()).toBe(false);
		  await wrapper.get('.jump-rail-toggle').trigger('click');
		  expect(wrapper.find('.user-jump-rail').exists()).toBe(true);
		  expect(wrapper.findAll('.user-jump-item')).toHaveLength(2);
		  expect(wrapper.find('.user-jump-index').text()).toBe('1');
		  await wrapper.findAll('.user-jump-item')[0].trigger('mouseenter');
		  expect(document.body.querySelector('.user-jump-preview')?.textContent).toContain('first prompt');
			  wrapper.unmount();
			 });
				it('coalesces tool lifecycle events and clears the running spinner',()=>{
			  const wrapper=mount(ConversationTimeline,{props:{messages:[{msg_id:'a1',turn_id:'t1',session_id:'s',role:'assistant',content:'done',timestamp:'2026-08-16T00:00:02Z',seq:4}],events:[
			   {id:'start',type:'tool_call',session:'s',timestamp:'2026-08-16T00:00:00Z',seq:1,metadata:{turn_id:'t1',item_id:'tool-1',tool:'read',status:'inProgress',phase:'started'}},
			   {id:'finish',type:'tool_call',session:'s',timestamp:'2026-08-16T00:00:01Z',seq:2,content:'ok',metadata:{turn_id:'t1',item_id:'tool-1',tool:'read',status:'completed',phase:'completed'}},
			   {id:'turn',type:'turn_completed',session:'s',timestamp:'2026-08-16T00:00:02Z',seq:3,metadata:{turn_id:'t1',status:'completed'}},
			  ],loading:false,pendingStates:{},activeTurn:false}});
			  expect(wrapper.findAll('.event-card')).toHaveLength(1);
				  expect(wrapper.find('.tool-group-icon [style*="animation"]').exists()).toBe(false);
				 });
				it('keeps a historical assistant turn that has only tool activity',()=>{
				  const wrapper=mount(ConversationTimeline,{props:{messages:[],events:[{id:'tool-only',type:'tool_call',session:'s',timestamp:'2026-08-16T00:00:00Z',seq:1,content:'done',metadata:{tool:'read',status:'completed'}}],loading:false,pendingStates:{},activeTurn:false}});
				  expect(wrapper.find('.assistant-turn-content').exists()).toBe(true);
				  expect(wrapper.findAll('.event-card')).toHaveLength(1);
				 });
				it('removes a reasoning panel when all reasoning events are empty',()=>{
				  const wrapper=mount(ReasoningPanel,{props:{events:[{id:'r1',type:'reasoning_status',session:'s',timestamp:'2026-08-16T00:00:00Z',seq:1,metadata:{phase:'completed'}}]}});
				  expect(wrapper.find('.reasoning-panel').exists()).toBe(false);
				 });
				it('shows all reasoning text when expanded',async()=>{
				  const wrapper=mount(ReasoningPanel,{props:{events:[
				    {id:'r1',type:'reasoning_status',session:'s',timestamp:'2026-08-16T00:00:00Z',seq:1,content:'先检查历史'},
				    {id:'r2',type:'reasoning_status',session:'s',timestamp:'2026-08-16T00:00:01Z',seq:2,content:'再合并重复项',metadata:{phase:'completed'}},
				  ]}});
				  await wrapper.get('button.reasoning-header').trigger('click');
				  expect(wrapper.get('.reasoning-body').text()).toContain('先检查历史');
				  expect(wrapper.get('.reasoning-body').text()).toContain('再合并重复项');
				 });
				});
