# Assumption Hidden Only in SDC

Timing report의 pass는 **분석한 clock·mode·path와 적용한 제약 조건 안에서의 pass**다. SDC에 “이 mode는 고정”, “이 path는 검사하지 않음”, “이 결과는 여러 cycle 뒤에 capture”라고 적어도 RTL이 그 동작을 강제하지는 않는다. Specification과 verification이 다른 계약을 사용하면 timing을 통과한 회로가 실제 transaction에서는 실패할 수 있다.

문제는 SDC를 사용하는 것이 아니다. Functional assumption의 유일한 기록이 SDC에 있고, RTL·검증·CDC·STA 담당자가 그 전제와 변경 조건을 공유하지 않는 것이 anti-pattern이다. 이 문서의 SDC는 timing constraint를 뜻하는 일반 명칭이며 실제 지원 명령·object type·우선순위는 target tool과 dialect에 따라 확인한다.

MCP의 edge 관계는 [Multi-Cycle Path](../03_timing/multi_cycle_path.md), CDC protocol은 [Multi-Bit CDC](../08_cdc/multi_bit_cdc.md), executable contract는 [Assertion-Driven RTL](../13_verification/assertion_driven_rtl.md)를 정본으로 삼는다. 여기서는 **제약 조건의 근거가 여러 산출물에서 함께 유지되는 방법**에 집중한다.

## 1. Bad example: mode가 고정이라고 SDC에만 적는다

다음은 같은 clock domain의 module 내부 fragment다. 우선순위는 **synchronous reset → config write → hold**다. `mode_q`가 진행 중인 datapath의 선택에도 사용되지만 write를 제한하는 logic은 없다.

```systemverilog
logic mode_q;

always_ff @(posedge clk) begin
    if (rst) begin
        mode_q <= 1'b0;
    end else if (cfg_write) begin
        mode_q <= cfg_mode_i;
    end
end

assign selected_data = mode_q ? service_data : normal_data;
```

STA 담당자는 normal-mode view에서 mode register의 실제 output pin을 0으로 case analysis했지만, specification에는 runtime write 금지가 없고 testbench도 busy 중 write를 검사하지 않는다고 하자. 그 view는 normal steady state의 일부 path만 분석할 수 있다. 실행 중 `mode_q`가 바뀌는 것이 불가능하다는 증거는 아니다.

예를 들어 시작할 때 normal mode였던 transaction이 끝나기 전에 service mode로 바뀌면 결과에 서로 다른 mode의 의미가 섞일 수 있다. Combinational select transition이 capture edge와 가까우면 별도의 timing 문제도 생긴다. 두 문제는 static mode 하나의 clean report로 해결되지 않는다.

다음 SDC 조각은 **mode가 primary input인 별도 설계에서의 잘못된 사용 상황**을 보여준다. 위 register 예제에 그대로 적용하는 실행용 제약 조건이 아니다.

```tcl
# Bad review context: runtime changes are legal, but only this view exists.
set_case_analysis 0 [get_ports service_mode_i]
```

이 명령 자체는 합법적인 static view에 필요할 수 있다. 잘못은 나머지 mode와 transition을 생략한 채 전체 동작이 검증됐다고 보고하는 것이다. AMD UG903도 case analysis를 특정 mode의 고정 신호를 timing engine에 알리는 방법으로 설명한다. Hardware write lock이나 mode-transition protocol을 생성하는 명령은 아니다. [AMD UG903, Case Analysis](https://docs.amd.com/r/en-US/ug903-vivado-using-constraints/Case-Analysis)

## 2. 네 종류의 제약 조건과 서로 다른 증명 의무

| 종류 | 분석에서 바꾸는 것 | SDC 밖에서 필요한 계약 | 확인할 evidence |
|---|---|---|---|
| Functional false path | 지정 경로의 timing check 제외 | 해당 mode에서 경로가 기능적으로 sensitized/captured되지 않는 이유 | Reachability/selection proof, mode coverage, 정확한 path 범위 |
| MCP | Launch/capture setup·hold edge 관계 | Source 보존, early capture/관찰 금지, 정해진 capture schedule | Cycle diagram, assertions, 실제 setup/hold edge report |
| Asynchronous clock groups | Group 간 일반 synchronous timing 분석 제외 | CDC structure와 protocol, clock 관계의 정의 | Crossing inventory, synchronizer/protocol 검증, 필요한 physical constraint |
| Case analysis | 특정 pin/port의 고정 값에 따른 arc/분석 공간 | 해당 view의 mode 값·유지 구간·진입/이탈 조건 | Mode matrix, config/reset/transition 검증, 다른 view의 coverage |

False-path 명령은 asynchronous crossing의 STA 처리에도 쓰일 수 있다. 이 경우 “회로가 그 경로를 사용하지 않는다”는 functional false-path 주장과 다르다. 실제 data가 넘어가는 경로라면 안정성은 CDC protocol과 구현 조건으로 확보해야 한다. 단순히 timing check에서 빠졌다는 사실은 그 증거가 아니다.

`set_false_path`의 구체적 범위·방향·setup/hold 선택과 의미는 해당 tool 문서 및 실제 적용 report로 확인한다. Broad clock-level exception을 단일 endpoint waiver처럼 설명하지 않는다. [AMD UG903, False Paths](https://docs.amd.com/r/en-US/ug903-vivado-using-constraints/False-Paths?contentId=qMX1lke2mkaFQEdACAPYlA)

## 3. Better pattern: mode 계약을 RTL에서 관찰 가능하게 만든다

다음 예제는 한 transaction만 처리하는 **mode guard**다. Datapath와 result protocol은 생략되어 있고, 모든 input은 `clk`에 synchronous하다고 가정한다. 비동기 configuration bus를 직접 받아도 된다는 뜻이 아니다.

계약은 다음과 같다.

- Reset edge에는 mode=0, idle로 돌아가며 acceptance는 없다.
- Idle에서 config와 start가 겹치면 **config가 우선**하고 start는 받아들이지 않는다.
- Busy 동안 config와 start는 받아들이지 않는다. 요청자는 acceptance를 확인하고 필요하면 재시도한다.
- Busy에서 `done_i`가 1이면 해당 edge 뒤 idle이 된다. Completion edge의 config/start를 동시에 받아들이지 않으므로 다음 edge부터 acceptance가 가능하다.
- `done_i`는 진행 중 transaction의 최종 사용/capture가 끝났음을 뜻한다. Idle에서의 `done_i`는 무시한다.

```systemverilog
module mode_guard (
    input  logic clk,
    input  logic rst,
    input  logic cfg_write,
    input  logic cfg_mode_i,
    input  logic start_req,
    input  logic done_i,
    output logic cfg_accept,
    output logic start_accept,
    output logic mode_q,
    output logic busy_q
);
    assign cfg_accept   = !rst && !busy_q && cfg_write;
    assign start_accept = !rst && !busy_q && !cfg_write && start_req;

    always_ff @(posedge clk) begin
        if (rst) begin
            mode_q <= 1'b0;
            busy_q <= 1'b0;
        end else begin
            if (cfg_accept) begin
                mode_q <= cfg_mode_i;
            end

            if (busy_q) begin
                if (done_i) begin
                    busy_q <= 1'b0;
                end
            end else if (start_accept) begin
                busy_q <= 1'b1;
            end
        end
    end
endmodule
```

Mode register의 우선순위는 **reset → accepted config → hold**, busy register는 **reset → busy completion → idle accepted start → hold**다. Config와 start의 우선관계는 acceptance logic에 명시했다. Latency를 줄여 completion과 다음 start를 동시에 받아들이려면 별도 계약으로 mode tag와 event priority를 다시 설계한다.

다음은 module 내부 또는 같은 signal을 참조할 수 있는 bound checker에 둘 property fragment다. Sample은 posedge의 preponed 값이며 non-overlapped implication은 이전 edge의 NBA 갱신을 다음 edge에서 확인한다.

```systemverilog
ap_mode_stable_while_busy:
    assert property (@(posedge clk) disable iff (rst)
        busy_q |=> $stable(mode_q));

ap_config_captures_mode:
    assert property (@(posedge clk) disable iff (rst)
        cfg_accept |=> (mode_q == $past(cfg_mode_i)));

ap_config_wins_idle_collision:
    assert property (@(posedge clk) disable iff (rst)
        (!busy_q && cfg_write && start_req)
        |-> (cfg_accept && !start_accept));

cp_busy_config_attempt:
    cover property (@(posedge clk) disable iff (rst)
        busy_q && cfg_write && (cfg_mode_i != mode_q));
```

마지막 cover는 “금지된 write 시도에 도달했는가”를 확인할 뿐 write 차단의 proof는 아니다. Stable property나 scoreboard와 조합한다. 여기서는 `disable iff (rst)`로 reset 중 property attempt를 abort한다. Synchronous reset의 state 갱신과 reset collision은 별도 checker로 확인하며, reset을 한 번도 주지 않은 초기 상태를 암묵적으로 정상 상태라고 취급하지 않는다.

### 이 guard만으로 case analysis를 정당화하지 않는다

`mode_q`가 busy 중 고정되어도 그 값이 항상 0인 것은 아니다. Mode 0/1의 supported steady-state view를 준비하고 idle 중 config 입력에서 mode register까지의 path와 mode commit에서 첫 사용까지의 path도 분석·검증한다. Case analysis로 mode pin의 변화를 제외한 view만으로는 이 범위를 모두 다룰 수 없다.

이 예제는 config acceptance와 같은 edge에서 start하지 않지만 이는 minimum functional spacing의 일부일 뿐이다. Datapath consumer, ready/valid, output 관찰, clock MUX를 포함한 안전성을 자동 보장하지 않는다. Clock source를 전환하는 mode에는 별도의 glitch-free switching, clock 정지·재개, reset/CDC 절차가 필요하다.

Mode를 RTL이 강제하지 않는 system-level 계약도 가능하다. 이 경우 environment assumption으로 명시하고 상위 block이나 software/hardware handshake의 보장·owner·integration check에 연결한다. Block-level formal에서 편의상 assume하는 것만으로는 상위 계약이 입증되지 않는다.

## 4. MCP: “3”이라는 숫자가 아니라 capture schedule을 공유한다

Functional multi-cycle intent의 예로 동일 clock에서 E0에 transaction A의 operand를 launch하고 E3에서 result register에 A의 결과를 capture하는 설계를 생각하자. E1/E2에서는 source A를 유지하고 destination capture를 막는다. 여기서는 controller가 **같은 edge의 result capture와 다음 operand refill을 함께 지원**하며, 다음 입력과 output 수용 여유가 준비되어 있다고 가정한다. 따라서 E0→E3의 **internal capture requirement=3 cycle, interface latency=4 cycle, II=3 cycle**인 예다. 이는 특정 회로의 signoff recipe가 아니다.

```text
Edge         | E0       | E1 / E2 | E3                    | E4 / E5 | E6
Operand FF   | launch A | hold A  | launch B after edge   | hold B  | launch C after edge
Result FF    | hold     | hold    | capture old result A  | hold    | capture old result B
```

E3의 destination FF는 edge 직전 A로부터 계산된 값을 capture한다. Source FF의 B 갱신은 같은 edge 이후 clock-to-Q delay를 거쳐 전파되므로, source Q를 E4까지 유지해야만 MCP가 성립하는 것은 아니다. 다만 새 B의 변화가 destination D의 E3 hold window를 침범하지 않아야 한다. **E0→E3의 A에 대한 max-delay/setup과 E3의 B launch에 대한 min-delay/hold를 모두 분석**하고 실제 clock skew, clock-to-Q, combinational minimum delay와 library hold requirement를 확인한다. RTL의 nonblocking assignment가 이전 값을 읽는다는 사실만으로 물리적 hold 안전성이 증명되지는 않는다.

E3에서 result와 valid를 NBA로 갱신해도 같은 E3의 posedge에서 동작하는 downstream FF는 새 A 결과를 아직 sample하지 않는다. 이 예에서 A의 valid가 E3 직후 올라가고 consumer가 ready라면 E4가 첫 synchronous consumption edge다. 이 E4 소비 시점은 B의 E3 launch를 막지 않는다. Backpressure가 있다면 result 유지와 overwrite 조건도 별도로 필요하다. E0→E3의 긴 combinational path와 result FF→consumer의 일반 path를 같은 MCP 범위에 넣지 않는다.

앞 절의 mode guard처럼 completion edge의 새 acceptance를 막는 controller에서 E3에 completion을 처리하면 다음 acceptance는 가장 빨라도 E4다. [MCP Used to Hide Timing](mcp_used_to_hide_timing.md)의 단순 single-operation 예제도 이 경우다. 두 예 모두 E0→E3 internal capture와 E4 first synchronous output observation을 사용하지만, II=4는 해당 controller의 선택이지 MCP 자체의 요구가 아니다. 위 II=3 schedule에는 capture/refill 동시 처리, A/B의 transaction identity와 output ordering을 보존하는 제어가 별도로 필요하다.

실패 예는 capture controller를 E3에서 E2로 변경했는데 SDC의 setup multiplier는 3으로 남는 경우다. Synthesis/STA가 새 functional deadline을 추측해 제약 조건을 수정해 주지는 않는다. 같은 global enable 이름을 사용하더라도 source가 중간에 갱신된다면 이 보존 계약은 성립하지 않는다.

MCP는 setup뿐 아니라 hold의 edge 관계도 바꾼다. 일반적인 동일 clock·동일 위상·동일 주기 조건에서 setup을 N cycle로 완화하고 원래 hold 관계를 유지하기 위해 hold 측에 N−1을 지정하는 예가 있다. 그러나 주기·위상·`-start`/`-end`가 다르면 기계적으로 적용할 수 없다. 실제 launch/capture waveform과 min/max report로 확인한다. [AMD UG903, Multicycle Paths](https://docs.amd.com/r/en-US/ug903-vivado-using-constraints/Multicycle-Paths), [Relaxing Setup While Maintaining Hold](https://docs.amd.com/r/en-US/ug903-vivado-using-constraints/Relaxing-Setup-While-Maintaining-Hold)

Review에서는 source stable, early capture 금지, capture 시 transaction 일치, reset/flush abort, next launch와의 hold 관계를 함께 다룬다. Control/enable 자체의 single-cycle path를 payload의 MCP에 포함하지 않는다. 구체적인 예와 실패 조건은 [MCP Used to Hide Timing](mcp_used_to_hide_timing.md)을 참고한다.

## 5. False path와 asynchronous groups: 분석 제외 후 무엇이 안전성을 보장하는가

### Functional false path

“Simulation에서 지나간 적이 없다”는 불가능성의 증명이 아니다. 합법 state, mode, test, reset release, illegal-input policy를 포함해 해당 startpoint에서 endpoint로의 변화가 기능적으로 capture되지 않는 이유를 제시한다. Mutually exclusive select가 근거라면 exclusivity가 DUT guarantee인지 environment assumption인지 명시한다.

Mode 추가, priority 변경, debug visibility 추가로 이전의 false path가 real path가 될 수 있다. Path가 존재하는지, false인 이유가 유지되는지, 다른 real path를 제외하지 않는지 각각 확인한다.

### Asynchronous clock groups

Asynchronous clock 관계를 정의해도 CDC 회로는 삽입되지 않는다. Single-bit synchronizer, handshake, asynchronous FIFO 등 transfer 의미에 맞는 구조가 필요하다.

Bundled-data transfer라면 적어도 source data가 request 전부터 destination capture까지 stable인 조건, control 동기화와 destination capture 조건, pulse 폭/간격, multi-bit coherency, reset 중 request/ack와 재개 후 ownership을 제시한다. 이 조건과 필요한 data delay/skew 제약은 [Bundled Data](../08_cdc/bundled_data.md)에 연결한다.

Clock group으로 crossing을 일괄 제외한 뒤 개별 max-delay 제약이 유효하다고 가정하지 않는다. 예를 들어 Vivado는 asynchronous clock groups가 다른 timing exception보다 우선하며, 개별 path를 제약·report해야 하는 경우 group 지정을 사용하지 않는 방침을 설명한다. 이는 특정 tool의 규칙이므로 이용 tool의 effective exception을 확인한다. [AMD UG903, Asynchronous Clock Groups](https://docs.amd.com/r/en-US/ug903-vivado-using-constraints/Asynchronous-Clock-Groups?contentId=FFct0eH7PsiUk6_RGLAncQ)

Bus skew처럼 path 간 관계를 제약하는 것을 개별 path의 max delay와 같은 우선순위 표로 판단하지 않는다. Generated clock 추가, clock MUX 변경, clock 이름 변경 시에는 관련 clock의 포함 범위도 재확인한다. Asynchronous와 physically/logically exclusive도 서로 바꿔 쓸 수 있는 의미가 아니다.

## 6. Mode를 값이 아니라 lifecycle로 관리한다

```text
reset --> idle/config --> mode commit --> run --> drain --> idle/config
  |                                          |
  +-------------- abort/reinitialize <-------+
```

Reset 중, boot/config, functional mode, service/test, drain, clock stop/resume는 같은 analysis view가 아니다. Supported steady state와 transition을 목록화하고 각 구간의 clock, mode 유지, outstanding transaction, reset/isolation, 허용 입력을 정의한다.

Mode 전환 시에는 “고정 값이 0에서 1이 된다”만이 아니라 누가 새 request를 막고, 어느 edge에서 이전 transaction이 끝나며, 언제부터 새 mode를 관찰해도 되는지 결정한다. 도중에 reset이 들어올 때의 abort/drain/preserve도 명시한다. 자세한 내용은 [Reset and Mode Transition Verification](../13_verification/reset_mode_transition_verification.md)을 참고한다.

각 mode의 static STA가 통과해도 transition의 protocol 검증은 남는다. 반대로 simulation에서 transition이 동작해도 구현의 setup/hold, clock switching이나 reset release가 보장된 것은 아니다.

## 7. Better workflow: assumption에 ID·증거·변경 트리거를 연결한다

Constraint owner만 의미를 아는 상태를 피한다. 다음 정보를 decision record나 constraint manifest에 정리하고 RTL comment·checker·SDC에서 같은 contract ID를 참조한다. 모든 사양을 각 파일에 복제할 필요는 없다.

| 기록 항목 | 기록할 내용 |
|---|---|
| Intent / mode | 필요한 이유, 유효한 동작 구간, 다른 mode의 coverage 위치 |
| Functional guarantee | Source 보존, capture edge, mode lock, exclusivity 등 구체적인 책임 |
| Scope | Start/end/through의 object type·exact resolved set·방향·clock domain |
| Timing meaning | Setup/hold edge, 제외 arc, 유지할 delay/skew/control path |
| Executable evidence | Property/test/CDC rule, proof 조건, coverage, negative test |
| Provenance | RTL/SDC revision, top/parameter, tool/version, netlist stage와 run ID |
| Ownership / trigger | RTL·verification·CDC·STA 담당 역할, 재리뷰가 필요한 변경 |

### Resolved scope를 검사한다

Empty collection으로 제약이 무효가 되는 경우와 wildcard가 넓어져 real path를 제외하는 경우를 모두 검출한다. 개수만 검사하면 같은 개수의 다른 object로 바뀐 오류를 놓친다. Hierarchy, clock domain, pin role과 가능한 범위에서 exact set을 비교하며 최적화로 object가 바뀌면 승인된 mapping을 남긴다.

Regression에는 적어도 “대상 rename으로 0개”, “비슷한 이름의 real endpoint 추가로 과도한 match”, “같은 개수지만 다른 domain의 object로 교체”를 넣는다. 이는 query의 건전성 검사이지 path가 기능적으로 false라는 proof가 아니다.

### Effective constraint를 검사한다

SDC의 text diff가 작아도 include 순서, IP scope, clock 정의, replication, tool version에 따라 적용 결과는 달라질 수 있다. Exception coverage, overridden/ignored exception, unconstrained endpoint, case analysis, 대표 path의 edge report를 저장한다.

Vivado는 clock groups, false path, min/max delay, MCP가 겹치는 경우의 우선순위를 정하고 object와 filter의 specificity도 구분한다. 마지막에 읽은 한 줄이 항상 우선하지는 않는다. 구체적인 우선순위와 예외는 이용 version에서 확인한다. [AMD UG903, Exceptions Priority](https://docs.amd.com/r/en-US/ug903-vivado-using-constraints/Exceptions-Priority?contentId=aHVP48Jpz5GK5j6K0Okx3A)

### Negative test를 assumption 밖에서 실행한다

Mode guard라면 busy 중 write를 시도하고 mode가 바뀌지 않는지 검사한다. Environment가 busy 중 write를 금지하는 계약이라면 상위 checker의 위반 검출을 별도 test로 확인한다. Formal에서 해당 입력을 assume으로 제외한 상태에서는 금지 조건을 깨는 반례가 나오지 않는다.

MCP라면 early capture, source 중간 갱신, reset 직후 stale valid를 checker가 검출하는지 확인한다. DUT와 같은 phase 비교식을 scoreboard에 복사하는 데 그치지 않고 accepted transaction과 사양상 deadline에서 기대 edge를 계산한다.

## 8. PPA trade-off와 허용 가능한 예외

Constraint 자체가 register나 synchronizer를 추가하지는 않는다. 다만 synthesis/P&R이 해당 timing budget이나 mode 제약을 최적화에 사용하면 cell 선택, sharing, buffering과 placement는 달라질 수 있다. 완화 후 area가 줄어도 mode/path coverage를 잃은 대가라면 PPA 개선이라고 부르지 않는다.

정당한 MCP는 multi-cycle datapath에 불필요한 고속화를 요구하지 않도록 할 수 있지만 capture controller, source/result hold와 throughput 비용이 있다. Mode lock은 select 안정성을 제공하는 대신 guard state, config handshake, drain latency와 verification 비용을 동반한다. CDC는 동기화 latency, handshake rate, buffer 용량과 physical 구현 조건을 포함한 설계 판단이다.

Power도 별도로 비교한다. 완화된 budget으로 작은 cell을 선택할 수 있어도 긴 combinational cone은 입력 변화에 따라 계속 toggle할 수 있다. Mode guard와 추가 buffer/FF는 자체 clock·data switching 비용을 가진다. 같은 workload, activity coverage, clock/macro 포함 범위에서 dynamic power와 leakage를 구분하고, SDC가 clock이나 operand를 자동으로 비활성화한다고 가정하지 않는다.

반대로 모든 exception을 없애고 엄격하게 만들면 안전해지는 것도 아니다. Asynchronous 관계에 의미 없는 synchronous requirement를 부과하거나 정당한 multi-cycle path를 single-cycle로 최적화하면 구현 판단이 왜곡된다. 올바른 분석 범위를 기능 계약에 대응시키는 것이 목적이다.

허용 가능한 예는 고정 strap에 대한 system 보장, 승인된 mode matrix, 검토한 IP 제공 exception, 상위에서 증명한 environment 제약이다. 모두 보장 범위, owner, integration 조건과 갱신 트리거가 필요하며 “예전부터 사용한 SDC”는 단독 근거가 되지 않는다.

## 9. Design Review Checklist

- [ ] 각 assumption의 의미를 SDC를 읽지 않고 spec/decision record로 설명할 수 있는가?
- [ ] DUT guarantee와 environment assumption을 구분하고 후자의 상위 보장이 있는가?
- [ ] Mode 값뿐 아니라 reset/config/run/drain/test/transition을 모두 다루는가?
- [ ] Mode write와 start/completion/reset collision의 우선순위가 명시되어 있는가?
- [ ] MCP의 source 보존·early capture 금지·실제 capture·consumer edge가 일치하는가?
- [ ] MCP의 setup/hold를 실제 clock waveform으로 확인하고 control path를 제외했는가?
- [ ] Functional false path와 asynchronous crossing의 분석 제외를 구분했는가?
- [ ] CDC의 안정성·pulse 폭·coherency·reset과 physical 제약의 책임이 명확한가?
- [ ] Object query의 empty·overmatch·같은 개수의 잘못된 대상을 검출할 수 있는가?
- [ ] Effective exception과 case analysis가 의도대로이며 우선순위에 따른 무효화가 없는가?
- [ ] Assumption을 깨는 negative test를 같은 assumption으로 배제하지 않았는가?
- [ ] RTL/clock/hierarchy/mode/tool 변경 시 SDC·checker·owner에게 재리뷰가 연결되는가?

## 관련 문서

- [Multi-Cycle Path](../03_timing/multi_cycle_path.md): functional intent와 setup/hold edge
- [MCP Used to Hide Timing](mcp_used_to_hide_timing.md): slack 은폐와 실제 capture 계약의 구분
- [Bundled Data](../08_cdc/bundled_data.md): data 안정성과 control 동기화 계약
- [Assertion-Driven RTL](../13_verification/assertion_driven_rtl.md): assume/assert/cover와 비공허한 검증
- [Reset and Mode Transition Verification](../13_verification/reset_mode_transition_verification.md): lifecycle과 transaction ownership
- [Ignoring Synthesis Result and Fanout](ignoring_synthesis_result_and_fanout.md): 분석 조건과 implementation evidence의 연결

## 참고 자료

- [AMD UG903, Case Analysis](https://docs.amd.com/r/en-US/ug903-vivado-using-constraints/Case-Analysis): mode별 고정 값과 timing arc 처리
- [AMD UG903, Multicycle Paths](https://docs.amd.com/r/en-US/ug903-vivado-using-constraints/Multicycle-Paths): launch/capture 제어와 setup/hold 관계
- [AMD UG903, Relaxing Setup While Maintaining Hold](https://docs.amd.com/r/en-US/ug903-vivado-using-constraints/Relaxing-Setup-While-Maintaining-Hold): single-clock MCP의 hold 관계
- [AMD UG903, False Paths](https://docs.amd.com/r/en-US/ug903-vivado-using-constraints/False-Paths?contentId=qMX1lke2mkaFQEdACAPYlA): timing check 제외의 의미와 지정 방법
- [AMD UG903, Asynchronous Clock Groups](https://docs.amd.com/r/en-US/ug903-vivado-using-constraints/Asynchronous-Clock-Groups?contentId=FFct0eH7PsiUk6_RGLAncQ): asynchronous group과 개별 path 제약의 경계
- [AMD UG903, Exceptions Priority](https://docs.amd.com/r/en-US/ug903-vivado-using-constraints/Exceptions-Priority?contentId=aHVP48Jpz5GK5j6K0Okx3A): 중복 exception의 우선순위와 scope
